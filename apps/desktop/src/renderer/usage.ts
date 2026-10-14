/**
 * 用量面板（m1 todo 12 = FR-2.5/2.6 渲染面；settings 视图内 usage-card）。
 *
 * - usage:summary 拉取 llm_calls 聚合（按天/按 provider+model）+ 自填单价表 + 全局 RPM + 探测档；
 * - 单价表/RPM 经 usage:setPricing / usage:setRpm 保存（0=不限流）；
 * - 不含任何笔记内容字段——面板只有计量元数据（02:354 同源纪律）。
 */

interface UsageBucketView {
  key: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costKnown: number;
  costEstimated: number;
  unestimatedCalls: number;
}

interface UsageSummaryView {
  sinceDays: number;
  totals: UsageBucketView;
  byDay: UsageBucketView[];
  byProviderModel: UsageBucketView[];
  pricing: Record<string, { inputPer1k?: number; outputPer1k?: number }>;
  rpmGlobal: number;
  providers: Array<{ provider: string; label: string; tier: string; tierSource: string; reachability: string }>;
}

/** bridge 类型与 renderer/main.ts 同源（window.xinglian，preload contextBridge 唯一暴露面） */
const bridge = window.xinglian;

const root = document.documentElement;
const totalsEl = document.getElementById('usage-totals');
const byDayEl = document.getElementById('usage-by-day');
const byProviderEl = document.getElementById('usage-by-provider');
const providersEl = document.getElementById('usage-providers');
const pricingInput = document.getElementById('usage-pricing-input') as HTMLTextAreaElement | null;
const pricingSaveBtn = document.getElementById('usage-pricing-save');
const pricingStatus = document.getElementById('usage-pricing-status');
const rpmInput = document.getElementById('usage-rpm-input') as HTMLInputElement | null;
const rpmSaveBtn = document.getElementById('usage-rpm-save');
const rpmStatus = document.getElementById('usage-rpm-status');

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('bridge missing'));
  return bridge.invoke(channel, payload) as Promise<T>;
}

function bucketLine(label: string, bucket: UsageBucketView): string {
  const costParts: string[] = [];
  if (bucket.costKnown > 0) costParts.push(`已知 ¥${bucket.costKnown}`);
  if (bucket.costEstimated > 0) costParts.push(`估算 ¥${bucket.costEstimated}`);
  if (bucket.unestimatedCalls > 0) costParts.push(`${bucket.unestimatedCalls} 次未估算`);
  return `${label}：${bucket.calls} 次调用，输入 ${bucket.tokensIn} tok / 输出 ${bucket.tokensOut} tok${costParts.length > 0 ? `，${costParts.join('，')}` : ''}`;
}

function fillTable(el: HTMLElement | null, rows: UsageBucketView[], emptyText: string): void {
  if (!el) return;
  el.textContent = '';
  if (rows.length === 0) {
    const line = document.createElement('p');
    line.className = 'usage-empty';
    line.textContent = emptyText;
    el.appendChild(line);
    root.dataset.usageLoaded = '1';
    return;
  }
  for (const row of rows) {
    const line = document.createElement('p');
    line.className = 'usage-row';
    line.textContent = bucketLine(row.key, row);
    el.appendChild(line);
  }
}

export function refreshUsagePanel(): void {
  if (!totalsEl) return;
  invoke<UsageSummaryView>('usage:summary', { days: 30 })
    .then((summary) => {
      totalsEl.textContent = `近 ${summary.sinceDays} 天合计——${bucketLine('全部', summary.totals)}`;
      fillTable(byDayEl, summary.byDay, '（窗口期内无调用记录）');
      fillTable(byProviderEl, summary.byProviderModel, '（窗口期内无调用记录）');
      if (providersEl) {
        providersEl.textContent = '';
        for (const provider of summary.providers) {
          const line = document.createElement('p');
          line.className = 'usage-row';
          const badge = provider.tierSource === 'probed' ? '' : provider.tierSource === 'network-unreachable' ? '【网络不可达】' : '【文档源，待实测】';
          line.textContent = `${provider.label}（${provider.provider}）：能力档 ${provider.tier}${badge}`;
          providersEl.appendChild(line);
        }
      }
      if (pricingInput && pricingInput.value.trim() === '') {
        pricingInput.value = Object.keys(summary.pricing).length > 0 ? JSON.stringify(summary.pricing) : '';
      }
      if (rpmInput) rpmInput.value = String(summary.rpmGlobal);
      root.dataset.usageLoaded = '1';
    })
    .catch((error: unknown) => {
      totalsEl.textContent = `用量读取失败：${String((error as Error).message).slice(0, 140)}`;
      root.dataset.usageLoaded = 'error';
    });
}

function bindUsageControls(): void {
  pricingSaveBtn?.addEventListener('click', () => {
    if (!pricingInput || !pricingStatus) return;
    let pricing: unknown;
    try {
      pricing = pricingInput.value.trim() === '' ? {} : JSON.parse(pricingInput.value);
    } catch (error) {
      pricingStatus.textContent = `单价表不是合法 JSON：${String((error as Error).message).slice(0, 100)}`;
      root.dataset.usagePricing = 'invalid-json';
      return;
    }
    invoke('usage:setPricing', { pricing })
      .then(() => {
        pricingStatus.textContent = '单价表已保存（下次聚合即生效）。';
        root.dataset.usagePricing = 'done';
      })
      .catch((error: unknown) => {
        pricingStatus.textContent = `保存失败：${String((error as Error).message).slice(0, 140)}`;
        root.dataset.usagePricing = 'failed';
      });
  });

  rpmSaveBtn?.addEventListener('click', () => {
    if (!rpmInput || !rpmStatus) return;
    const rpm = Number(rpmInput.value);
    if (!Number.isFinite(rpm) || rpm < 0) {
      rpmStatus.textContent = 'RPM 必须是非负整数（0=不限流）。';
      root.dataset.usageRpm = 'invalid-input';
      return;
    }
    invoke('usage:setRpm', { rpm: Math.floor(rpm) })
      .then(() => {
        rpmStatus.textContent = rpm > 0 ? `全局 RPM 已设为 ${Math.floor(rpm)}（下一次报告调用生效）。` : '已关闭限额（0=不限流）。';
        root.dataset.usageRpm = 'done';
      })
      .catch((error: unknown) => {
        rpmStatus.textContent = `保存失败：${String((error as Error).message).slice(0, 140)}`;
        root.dataset.usageRpm = 'failed';
      });
  });
}

export function initUsageView(): void {
  refreshUsagePanel();
  bindUsageControls();
}
