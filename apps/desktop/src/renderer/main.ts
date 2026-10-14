/**
 * 渲染进程入口（纯 UI，02 §4.1：渲染进程不可直接访问文件/网络系统 API）。
 *
 * - 九视图导航：点击侧边栏 → window.xinglian.navigate(view)（app:navigate 通道，
 *   主进程 zod 校验 + 记录）→ 成功后切换 section；data-last-navigate 供 e2e 断言真实 IPC 往返。
 * - 登录占位：纯 DOM 本地路由，不发任何网络请求（M0 不接后端）。
 * - app:info：挂载后拉取壳层版本信息展示。
 * - 挂载完成即移除首屏骨架（C-3 招三），并在 html 上标记 data-app-mounted 供 e2e 等待。
 */
import { E_EULA_LOCKED } from '../shared/channels';
import type { ViewId } from '../shared/types';
import { initInsightView, refreshInsightView } from './insight';
import { initUsageView, refreshUsagePanel } from './usage';
import { initReportView } from './reportView';

const bridge = window.xinglian;

const appEl = document.getElementById('app');
const skeletonEl = document.getElementById('boot-skeleton');
const topbarTitle = document.getElementById('topbar-title');
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item[data-view]'));
const sections = Array.from(document.querySelectorAll<HTMLElement>('.view[data-view]'));
const root = document.documentElement;
const eulaNavBanner = document.getElementById('eula-nav-banner');

function setHtmlFlag(key: string, value: string): void {
  root.dataset[key] = value;
}

/** 本地切换九视图（IPC 成功后才调用；login 走独立本地路由） */
function switchView(view: string, title: string): void {
  for (const btn of navButtons) {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    if (active) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  }
  for (const section of sections) {
    section.classList.toggle('active', section.dataset.view === view);
  }
  if (topbarTitle && title) topbarTitle.textContent = title;
  /* 洞察视图每次激活即刷新（采集列表/闸门可能已被后台任务推进） */
  if (view === 'insight') refreshInsightView();
  /* 设置视图激活即刷新用量面板（报告跑完回来看消耗） */
  if (view === 'settings') refreshUsagePanel();
}

function localFallback(view: string): void {
  const btn = navButtons.find((b) => b.dataset.view === view);
  switchView(view, btn?.dataset.viewTitle ?? view);
}

for (const btn of navButtons) {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (!view) return;
    if (!bridge) {
      setHtmlFlag('bridge', 'missing');
      localFallback(view);
      return;
    }
    bridge
      .navigate(view as ViewId)
      .then(() => {
        setHtmlFlag('lastNavigate', view);
        setHtmlFlag('lastIpc', 'ok');
        switchView(view, btn.dataset.viewTitle ?? view);
      })
      .catch((error: unknown) => {
        // EULA 路由锁（todo 9 / FR-1.9）：主进程拒绝工作流视图导航 → 不切换，展示锁提示
        const message = String(error);
        if (message.includes(E_EULA_LOCKED)) {
          root.dataset.eulaNav = 'denied';
          eulaNavBanner?.removeAttribute('hidden');
          return;
        }
        // 理论上九视图 id 都在白名单内；被拒说明契约被破坏——保守地仍切换视图但留下证据标记
        console.warn('[renderer] navigate rejected:', error);
        setHtmlFlag('lastIpc', 'rejected');
        localFallback(view);
      });
  });
}

const loginButton = document.getElementById('topbar-login');
const loginSection = document.getElementById('view-login');loginButton?.addEventListener('click', () => {
  const title = loginButton.dataset.viewTitle ?? '登录';
  for (const section of sections) section.classList.remove('active');
  for (const btn of navButtons) {
    btn.classList.remove('active');
    btn.removeAttribute('aria-current');
  }
  loginSection?.classList.add('active');
  if (topbarTitle) topbarTitle.textContent = title;
  setHtmlFlag('lastNavigate', 'login');
  setHtmlFlag('lastIpc', 'local');
});

const loginForm = document.getElementById('login-form') as HTMLFormElement | null;
const loginMsg = document.getElementById('login-msg');
loginForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (loginMsg) loginMsg.textContent = 'M0 占位：登录后端未接入（todo 2 提供服务端），未发出任何请求。';
});

/* ============================== license 状态与锁定（todo 8 = T-M0-07） ==============================
 * 状态机出口来自主进程 license:status / license:activate（离线验签 + 72h 宽限，FR-1.5/1.6）。
 * 锁定语义：只锁工作流写入口（dashboard/insight/sourcing/publish/promo/review 的执行入口置灰），
 * 路由可达性不收缩——logs/settings 保持可达，report（历史数据查看占位）亦可达。
 */
const WORKFLOW_WRITE_VIEWS = ['dashboard', 'insight', 'sourcing', 'publish', 'promo', 'review'] as const;

interface LicenseStatusView {
  state: 'unlocked' | 'locked';
  reason: string;
  plan?: string;
  tier?: string;
  deviceLimit?: number;
  expiresAt?: string;
  lastVerifiedAt?: string;
  graceEndsAt?: string;
  deviceHash?: string;
  licenseDeviceHash?: string;
}

const licenseStatusLine = document.getElementById('license-status-line');
const licenseDeviceLine = document.getElementById('license-device-line');
const licenseActivateForm = document.getElementById('license-activate-form') as HTMLFormElement | null;
const licenseJwtInput = document.getElementById('license-jwt-input') as HTMLInputElement | null;
const licenseActivateMsg = document.getElementById('license-status-line');

function describeStatus(status: LicenseStatusView): string {
  if (status.state === 'unlocked') {
    const grace = status.graceEndsAt ? `，72h 宽限至 ${new Date(status.graceEndsAt).toLocaleString()}` : '';
    return `license 状态：已解锁（${status.plan ?? '?'}/${status.tier ?? '?'}，设备上限 ${status.deviceLimit ?? '?'}${grace}）`;
  }
  const reasonText: Record<string, string> = {
    NO_LICENSE: '未激活（无 license）',
    EXPIRED: '已到期（FR-1.6）',
    GRACE_EXCEEDED: '离线超过 72h 宽限（FR-1.5）',
    DEVICE_MISMATCH: 'license 绑定到其他设备',
    ALG_REJECTED: '验签失败（算法不被接受）',
    SIGNATURE_INVALID: '验签失败（签名不匹配）',
    TYPE_REJECTED: '验签失败（不是 license）',
    MALFORMED: 'license 内容损坏',
    NO_VERIFICATION: '缺少验签时间戳',
  };
  return `license 状态：已锁定（${reasonText[status.reason] ?? status.reason}）——工作流执行入口不可用，历史与日志仍可访问。`;
}

/** 把状态机出口应用到 UI：html 数据标记（e2e 断言面）+ 执行入口置灰/恢复 + 锁定横幅 + 设置页状态行 */
function applyLicenseStatus(status: LicenseStatusView): void {
  root.dataset.licenseState = status.state;
  root.dataset.licenseReason = status.reason;
  root.dataset.licenseLoaded = '1';
  const locked = status.state === 'locked';
  for (const view of sections) {
    const viewId = view.dataset.view ?? '';
    if (!(WORKFLOW_WRITE_VIEWS as readonly string[]).includes(viewId)) continue;
    view.dataset.entryLocked = String(locked);
    const entry = view.querySelector<HTMLButtonElement>('.workflow-entry[data-write-entry]');
    if (entry) entry.disabled = locked;
    const banner = view.querySelector<HTMLElement>('[data-license-lock]');
    if (banner) banner.hidden = !locked;
  }
  if (licenseStatusLine) licenseStatusLine.textContent = describeStatus(status);
  if (licenseDeviceLine) {
    if (status.deviceHash) {
      licenseDeviceLine.hidden = false;
      licenseDeviceLine.textContent = `本机设备指纹哈希：${status.deviceHash.slice(0, 16)}…（仅哈希上行，02 §11.4）`;
    } else {
      licenseDeviceLine.hidden = true;
    }
  }
}

function refreshLicenseStatus(): void {
  if (!bridge) return;
  bridge
    .invoke('license:status')
    .then((data) => applyLicenseStatus(data as LicenseStatusView))
    .catch((error: unknown) => {
      console.warn('[renderer] license:status failed:', error);
      root.dataset.licenseLoaded = 'error';
    });
}

licenseActivateForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const jwt = licenseJwtInput?.value.trim() ?? '';
  if (!bridge || jwt.length === 0) {
    if (licenseActivateMsg) licenseActivateMsg.textContent = 'license 状态：请粘贴 license JWT 后再激活。';
    root.dataset.licenseActivate = 'invalid-input';
    return;
  }
  root.dataset.licenseActivate = 'pending';
  bridge
    .invoke('license:activate', { licenseJwt: jwt })
    .then((data) => {
      applyLicenseStatus(data as LicenseStatusView);
      root.dataset.licenseActivate = 'done';
      if (licenseJwtInput) licenseJwtInput.value = '';
    })
    .catch((error: unknown) => {
      console.warn('[renderer] license:activate failed:', error);
      root.dataset.licenseActivate = 'failed';
      if (licenseActivateMsg) {
        licenseActivateMsg.textContent = `激活失败：${String(error).slice(0, 160)}（M0 本地验签拒绝；请检查 license 是否完整/未篡改）`;
      }
    });
});

/* ============================== EULA 首启确认门 + 遥测 opt-in（todo 9 = T-M0-11） ==============================
 * FR-1.9：首启（无确认记录）或版本变更（requiresConfirm）→ 弹 EULA+隐私政策确认弹窗；
 * 确认/拒绝记录经主进程落 SQLite consents 表（版本号+时间戳留痕）。
 * 路由锁在主进程 app:navigate 强制（六个工作流视图拒绝）；本层负责弹窗/横幅/断言标记渲染。
 * FR-12.6：弹窗内独立勾选征求遥测（默认不勾=opt-in）；设置页可随时开关。
 */
interface ConsentStateView {
  eulaVersion: string;
  eulaStatus: 'unconfirmed' | 'accepted' | 'rejected' | 'version-changed';
  requiresConfirm: boolean;
  confirmedVersion: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  telemetryConsent: 'granted' | 'denied' | 'unasked';
}

const eulaModal = document.getElementById('eula-modal');
const eulaVersionLabel = document.getElementById('eula-version-label');
const eulaReconfirmNote = document.getElementById('eula-reconfirm-note');
const eulaTelemetryCheckbox = document.getElementById('eula-telemetry-consent') as HTMLInputElement | null;
const eulaAcceptBtn = document.getElementById('eula-accept-btn');
const eulaRejectBtn = document.getElementById('eula-reject-btn');
const eulaRejectMsg = document.getElementById('eula-reject-msg');
const telemetryToggle = document.getElementById('telemetry-toggle') as HTMLInputElement | null;
const telemetryStatusLine = document.getElementById('telemetry-status-line');

const TELEMETRY_STATUS_TEXT: Record<ConsentStateView['telemetryConsent'], string> = {
  granted: '遥测状态：已开启——匿名使用事件将在上报通道接入后发送（M0 阶段无上报通道，仅本地记录）。',
  denied: '遥测状态：已关闭——漏斗/熔断/埋点事件均不上传、仅本地留存（FR-12.6）。',
  unasked: '遥测状态：尚未征求同意（首启弹窗征求；默认不开启）。',
};

function renderTelemetryStatus(state: ConsentStateView): void {
  if (telemetryStatusLine) telemetryStatusLine.textContent = TELEMETRY_STATUS_TEXT[state.telemetryConsent];
}

/** 把 consent 门态应用到 UI：html 数据标记（e2e 断言面）+ 弹窗开合 + 遥测开关回填 */
function applyConsentState(state: ConsentStateView): void {
  root.dataset.consentLoaded = '1';
  root.dataset.eulaState = state.eulaStatus;
  root.dataset.eulaRequiresConfirm = state.requiresConfirm ? '1' : '0';
  root.dataset.eulaReconfirm = state.eulaStatus === 'version-changed' ? '1' : '0';
  root.dataset.telemetryConsent = state.telemetryConsent;

  if (state.requiresConfirm) {
    if (eulaVersionLabel) eulaVersionLabel.textContent = state.eulaVersion;
    if (eulaReconfirmNote) {
      eulaReconfirmNote.hidden = state.confirmedVersion === null;
      eulaReconfirmNote.textContent =
        state.confirmedVersion === null
          ? ''
          : `协议已更新：你此前确认的是 v${state.confirmedVersion}，需重新确认 v${state.eulaVersion} 后继续使用工作流功能。`;
    }
    if (eulaRejectMsg) eulaRejectMsg.hidden = state.eulaStatus !== 'rejected';
    // 遥测勾选回填当前同意态（重确认不静默撤销既有同意；首启 unasked → 不勾选 = opt-in 默认关闭）
    if (eulaTelemetryCheckbox) eulaTelemetryCheckbox.checked = state.telemetryConsent === 'granted';
    eulaModal?.removeAttribute('hidden');
    root.dataset.eulaModal = 'open';
  } else {
    eulaModal?.setAttribute('hidden', '');
    root.dataset.eulaModal = 'closed';
  }

  if (telemetryToggle) telemetryToggle.checked = state.telemetryConsent === 'granted';
  renderTelemetryStatus(state);
}

function refreshConsentState(): void {
  if (!bridge) {
    root.dataset.consentLoaded = 'missing-bridge';
    return;
  }
  bridge
    .invoke('consent:state')
    .then((data) => applyConsentState(data as ConsentStateView))
    .catch((error: unknown) => {
      console.warn('[renderer] consent:state failed:', error);
      root.dataset.consentLoaded = 'error';
    });
}

eulaAcceptBtn?.addEventListener('click', () => {
  if (!bridge) return;
  root.dataset.eulaAccept = 'pending';
  bridge
    .invoke('consent:acceptEula', { telemetryConsent: eulaTelemetryCheckbox?.checked ?? false })
    .then((data) => {
      applyConsentState(data as ConsentStateView);
      root.dataset.eulaAccept = 'done';
    })
    .catch((error: unknown) => {
      console.warn('[renderer] consent:acceptEula failed:', error);
      root.dataset.eulaAccept = 'failed';
    });
});

eulaRejectBtn?.addEventListener('click', () => {
  if (!bridge) return;
  root.dataset.eulaReject = 'pending';
  bridge
    .invoke('consent:rejectEula')
    .then((data) => {
      applyConsentState(data as ConsentStateView);
      root.dataset.eulaReject = 'shown';
      // 拒绝态：弹窗保持 + 退出提示可见（应用可关；功能持续锁定）
      eulaModal?.removeAttribute('hidden');
      root.dataset.eulaModal = 'open';
      if (eulaRejectMsg) eulaRejectMsg.hidden = false;
    })
    .catch((error: unknown) => {
      console.warn('[renderer] consent:rejectEula failed:', error);
      root.dataset.eulaReject = 'failed';
    });
});

telemetryToggle?.addEventListener('change', () => {
  if (!bridge || !telemetryToggle) return;
  const enabled = telemetryToggle.checked;
  root.dataset.telemetrySet = 'pending';
  bridge
    .invoke('consent:setTelemetry', { enabled })
    .then((data) => {
      applyConsentState(data as ConsentStateView);
      root.dataset.telemetrySet = 'done';
    })
    .catch((error: unknown) => {
      console.warn('[renderer] consent:setTelemetry failed:', error);
      root.dataset.telemetrySet = 'failed';
      telemetryToggle.checked = !enabled; // 失败回滚开关，等下次 state 同步
    });
});

/* ============================== 受控浏览器接管（todo 10 = T-M0-08） ==============================
 * 三态标题栏（FR-3.5）+ 平台快捷入口（FR-3.2）+ 一键断开 + 让位指示（FR-4.5）+ 失效引导横幅（FR-3.4）。
 * 状态真源在主进程（browser-service），本层 1s 轮询 browser:status 同步；html data 标记为 e2e 断言面。
 */
interface BrowserStatusView {
  state: 'detached' | 'attached' | 'login-expired';
  yielded: boolean;
  yieldReason: string | null;
  browserVersion: string | null;
  browserPid: number | null;
  openTabs: { targetId: string; url: string }[] | null;
  lastError: string | null;
}

const browserChip = document.getElementById('browser-state-chip');
const yieldChip = document.getElementById('browser-yield-chip');
const loginBanner = document.getElementById('browser-login-banner');
const openXhsBtn = document.getElementById('browser-open-xhs') as HTMLButtonElement | null;
const open1688Btn = document.getElementById('browser-open-1688') as HTMLButtonElement | null;
const disconnectBtn = document.getElementById('browser-disconnect') as HTMLButtonElement | null;

const BROWSER_STATE_TEXT: Record<BrowserStatusView['state'], string> = {
  detached: '浏览器：未接管',
  attached: '浏览器：已接管',
  'login-expired': '浏览器：登录失效',
};

function applyBrowserStatus(status: BrowserStatusView): void {
  root.dataset.browserState = status.state;
  root.dataset.browserYielded = status.yielded ? '1' : '0';
  if (browserChip) {
    browserChip.dataset.state = status.state;
    browserChip.textContent = BROWSER_STATE_TEXT[status.state];
    browserChip.title = status.browserVersion ? `CDP: ${status.browserVersion}` : '';
  }
  if (yieldChip) yieldChip.hidden = !status.yielded;
  if (loginBanner) loginBanner.hidden = status.state !== 'login-expired';
  if (disconnectBtn) disconnectBtn.disabled = status.state === 'detached';
}

function refreshBrowserStatus(): void {
  if (!bridge) return;
  bridge
    .invoke('browser:status')
    .then((data) => applyBrowserStatus(data as BrowserStatusView))
    .catch((error: unknown) => {
      console.warn('[renderer] browser:status failed:', error);
      root.dataset.browserState = 'detached';
    });
}

async function openPlatform(platform: 'xhs' | '1688', btn: HTMLButtonElement | null): Promise<void> {
  if (!bridge || !btn) return;
  btn.disabled = true;
  root.dataset.browserOpen = 'pending';
  try {
    const result = (await bridge.invoke('browser:openPlatform', { platform })) as { state: string };
    root.dataset.browserOpen = 'done';
    root.dataset.browserOpenPlatform = platform;
    applyBrowserStatusField(result.state);
  } catch (error: unknown) {
    root.dataset.browserOpen = 'failed';
    root.dataset.browserOpenError = String(error).slice(0, 160);
    console.warn('[renderer] browser:openPlatform failed:', error);
  } finally {
    btn.disabled = false;
    refreshBrowserStatus();
  }
}

function applyBrowserStatusField(state: string): void {
  const map: Record<string, string> = { detached: '未接管', attached: '已接管', 'login-expired': '登录失效' };
  if (browserChip) {
    browserChip.dataset.state = state;
    browserChip.textContent = `浏览器：${map[state] ?? state}`;
  }
}

openXhsBtn?.addEventListener('click', () => void openPlatform('xhs', openXhsBtn));
open1688Btn?.addEventListener('click', () => void openPlatform('1688', open1688Btn));
disconnectBtn?.addEventListener('click', () => {
  if (!bridge) return;
  root.dataset.browserDisconnect = 'pending';
  bridge
    .invoke('browser:disconnect')
    .then(() => {
      root.dataset.browserDisconnect = 'done';
    })
    .catch((error: unknown) => {
      root.dataset.browserDisconnect = 'failed';
      console.warn('[renderer] browser:disconnect failed:', error);
    })
    .finally(() => refreshBrowserStatus());
});

// 状态轮询（1s）：三态/让位/失效横幅均由主进程状态机驱动
setInterval(refreshBrowserStatus, 1000);
refreshBrowserStatus();

/* ============================== BYOK Key 配置（m1 todo 10 = T-M1-08①） ==============================
 * FR-2.7 三要素：①「调用内容发送范围说明」固定展示（静态文案位 #key-scope-note）；
 * ②服务商境内外标注（数据源 = docs/adr/provider-matrix.md 风险列 + presets.ts reachability）；
 * ③调用前确认 modal（keys:precall-confirm——每 provider 每会话一次；设置页可重置）。
 * R9 角标口径（provider-matrix §3）：仅实测通过格解除「文档源，待实测」角标；实测失败格
 * （zhipu json_schema）不承诺能力且不挂「文档源」角标（标注实测结论）；documented 格一律带角标。
 */
interface KeyCapMeta {
  key: string;
  label: string;
  supported: boolean;
  source: 'documented' | 'probed';
  note: string;
}

interface KeyProviderMeta {
  id: string;
  label: string;
  region: '境内' | '境外';
  regionNote: string;
  capabilities: KeyCapMeta[];
}

// 逐格数据与 presets.ts PROVIDER_CAPABILITY_PRESETS / provider-matrix §1 互链镜像（2026-10-13 实测口径）
const KEY_PROVIDER_META: KeyProviderMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    region: '境内',
    regionNote: '境内（可达性实测 ✅ 401/249ms）',
    capabilities: [
      { key: 'json_schema', label: 'json_schema', supported: false, source: 'documented', note: '仅 json_object（提示词引导）；原生 json_schema 仅 Beta strict 模式' },
      { key: 'tool_calling', label: 'tool calling', supported: true, source: 'documented', note: '官方支持（思考模式自 V3.2）' },
      { key: 'embeddings', label: 'embeddings', supported: false, source: 'documented', note: '官方 API 目录无 /embeddings 端点' },
    ],
  },
  {
    id: 'tongyi',
    label: '通义（阿里云百炼）',
    region: '境内',
    regionNote: '境内（✅ 401/189ms）；注：跨境（新加坡）地域配置会出境',
    capabilities: [
      { key: 'json_schema', label: 'json_schema', supported: true, source: 'documented', note: 'compatible-mode 原生支持（限 Qwen3.7+ 系列）' },
      { key: 'tool_calling', label: 'tool calling', supported: true, source: 'documented', note: 'tools/function calling 官方支持' },
      { key: 'embeddings', label: 'embeddings', supported: true, source: 'documented', note: 'text-embedding-v3/v4 官方支持' },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱（BigModel）',
    region: '境内',
    regionNote: '境内（✅ 401/162ms）',
    capabilities: [
      { key: 'json_schema', label: 'json_schema', supported: false, source: 'probed', note: '实测 2026-10-13：请求被接受但返回空内容——原生 json_schema 不可用，走降级链' },
      { key: 'tool_calling', label: 'tool calling', supported: true, source: 'probed', note: '实测 2026-10-13：glm-4.7-flash tool_calls 通过' },
      { key: 'embeddings', label: 'embeddings', supported: true, source: 'documented', note: 'embedding-3 文档支持；实测因 Key 无余额未获结论' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    region: '境外',
    regionNote: '境外（不可达实测 ❌ UND_ERR_CONNECT_TIMEOUT）——调用出境且境内网络不可达，需自备可达网络',
    capabilities: [
      { key: 'json_schema', label: 'json_schema', supported: true, source: 'documented', note: 'Structured Outputs 原生支持（gpt-4o-mini 及以后）' },
      { key: 'tool_calling', label: 'tool calling', supported: true, source: 'documented', note: '原生支持' },
      { key: 'embeddings', label: 'embeddings', supported: true, source: 'documented', note: 'text-embedding-3 系列原生支持' },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动（SiliconFlow）',
    region: '境内',
    regionNote: '境内主站（✅ 401/214ms）；注：境外托管模型/国际版端点配置则调用出境',
    capabilities: [
      { key: 'json_schema', label: 'json_schema', supported: false, source: 'documented', note: '仅承诺 json_object，无原生 json_schema 档' },
      { key: 'tool_calling', label: 'tool calling', supported: true, source: 'documented', note: 'function calling 官方支持（模型依存）' },
      { key: 'embeddings', label: 'embeddings', supported: true, source: 'documented', note: 'BAAI/bge-m3 等官方支持' },
    ],
  },
  {
    id: 'custom',
    label: '自定义网关（base_url）',
    region: '境内',
    regionNote: '数据去向由你配置的网关决定（D11 运行时通道；请自行确认服务商数据出境属性）',
    capabilities: [],
  },
];

const keyProviderTable = document.getElementById('key-provider-table');

function renderKeyProviderTable(): void {
  if (!keyProviderTable) return;
  keyProviderTable.textContent = '';
  for (const provider of KEY_PROVIDER_META) {
    const row = document.createElement('div');
    row.className = 'key-provider-row';
    row.dataset.provider = provider.id;
    row.dataset.region = provider.region;
    const name = document.createElement('span');
    name.className = 'key-provider-name';
    name.textContent = provider.label;
    const region = document.createElement('span');
    region.className = 'key-provider-region';
    region.dataset.regionLabel = provider.region;
    region.textContent = provider.region;
    const regionNote = document.createElement('span');
    regionNote.className = 'key-provider-region-note';
    regionNote.textContent = provider.regionNote;
    row.append(name, region, regionNote);
    for (const cap of provider.capabilities) {
      const cell = document.createElement('span');
      cell.className = 'key-cap';
      cell.dataset.capProvider = provider.id;
      cell.dataset.capKey = cap.key;
      cell.dataset.capSource = cap.source;
      cell.dataset.capSupported = String(cap.supported);
      const promise = document.createElement('span');
      // 能力承诺文案：supported=false 不承诺（❌ + 实测/文档结论）；supported=true 承诺档位
      promise.textContent = `${cap.label} ${cap.supported ? '✅ 可用' : '❌ 不可用'}`;
      const note = document.createElement('em');
      note.className = 'cap-note';
      note.textContent = `（${cap.note}）`;
      cell.append(promise, note);
      if (cap.source === 'documented') {
        // R9：documented 格一律带角标（实测通过格才可解除——provider-matrix §3）
        const badge = document.createElement('span');
        badge.className = 'cap-badge';
        badge.dataset.capBadge = 'documented';
        badge.textContent = '文档源，待实测';
        cell.appendChild(badge);
      } else {
        const probedMark = document.createElement('span');
        probedMark.className = 'cap-badge cap-badge--probed';
        probedMark.dataset.capBadge = 'probed';
        probedMark.textContent = cap.supported ? '实测 2026-10-13 通过' : '实测 2026-10-13 不支持';
        cell.appendChild(probedMark);
      }
      row.appendChild(cell);
    }
    keyProviderTable.appendChild(row);
  }
}
renderKeyProviderTable();

const keyStorageWarning = document.getElementById('key-storage-warning');
const keyStatusLine = document.getElementById('key-status-line');
const keyMaskedList = document.getElementById('key-masked-list');
const keySetForm = document.getElementById('key-set-form') as HTMLFormElement | null;
const keyProviderSelect = document.getElementById('key-provider-select') as HTMLSelectElement | null;
const keyInput = document.getElementById('key-input') as HTMLInputElement | null;
const keyBaseUrlInput = document.getElementById('key-baseurl-input') as HTMLInputElement | null;
const keyModelInput = document.getElementById('key-model-input') as HTMLInputElement | null;
const keyBackupInput = document.getElementById('key-backup-input') as HTMLTextAreaElement | null;
const keyTestBtn = document.getElementById('key-test-btn');
const keyTestStatus = document.getElementById('key-test-status');
const precallResetBtn = document.getElementById('key-precall-reset-btn');
const precallModal = document.getElementById('precall-modal');
const precallProviderLine = document.getElementById('precall-provider-line');
const precallConfirmBtn = document.getElementById('precall-confirm-btn');
const precallCancelBtn = document.getElementById('precall-cancel-btn');
const scanTestBtn = document.getElementById('scan-test-btn');
const scanTestInput = document.getElementById('scan-test-input') as HTMLTextAreaElement | null;
const scanTestResult = document.getElementById('scan-test-result');

interface KeyMaskedEntryView {
  provider: string;
  masked: string | null;
  backupMasked?: string[];
  encryption: 'safeStorage' | 'plaintext-fallback' | null;
  baseUrl: string | null;
  model: string | null;
  setAt: string | null;
}

const KEY_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  tongyi: '通义',
  zhipu: '智谱',
  openai: 'OpenAI',
  siliconflow: '硅基流动',
  custom: '自定义网关',
};

function applyMaskedKeys(result: { keys: KeyMaskedEntryView[] }): void {
  if (!keyMaskedList || !keyStatusLine) return;
  keyMaskedList.textContent = '';
  let plaintextFallback = false;
  let anyConfigured = false;
  for (const entry of result.keys) {
    if (entry.encryption === 'plaintext-fallback') plaintextFallback = true;
    const line = document.createElement('p');
    line.className = 'key-masked-line';
    line.dataset.provider = entry.provider;
    if (entry.masked) {
      anyConfigured = true;
      const encryptionLabel = entry.encryption === 'safeStorage' ? 'safeStorage 加密' : '明文降级（告警）';
      const backupNote = entry.backupMasked && entry.backupMasked.length > 0 ? `，备用 ${entry.backupMasked.length} 把（${entry.backupMasked.join(' / ')}）` : '';
      line.textContent = `${KEY_PROVIDER_LABELS[entry.provider] ?? entry.provider}：${entry.masked}（${encryptionLabel}${entry.setAt ? `，${entry.setAt.slice(0, 10)}` : ''}${backupNote}）`;
    } else {
      line.textContent = `${KEY_PROVIDER_LABELS[entry.provider] ?? entry.provider}：未配置`;
    }
    keyMaskedList.appendChild(line);
  }
  keyStatusLine.textContent = anyConfigured ? 'Key 状态：已保存（只回显掩码，全值不再展示）。' : 'Key 状态：尚无已保存的 Key。';
  // safeStorage 不可用降级 → 显式告警横幅（绝不静默，FR-2.7/PC-03①）
  if (keyStorageWarning) {
    keyStorageWarning.hidden = !plaintextFallback;
    if (plaintextFallback) {
      keyStorageWarning.textContent =
        '⚠️ safeStorage 不可用：存在以明文本地保存的 Key（已写审计日志）。建议尽快在支持 OS 级凭据保护的环境中更换保存。';
    }
  }
  root.dataset.keyMaskedLoaded = '1';
  root.dataset.keyPlaintextWarning = plaintextFallback ? '1' : '0';
}

function refreshMaskedKeys(): void {
  if (!bridge) return;
  bridge
    .invoke('keys:get-masked')
    .then((data) => applyMaskedKeys(data as { keys: KeyMaskedEntryView[] }))
    .catch((error: unknown) => {
      console.warn('[renderer] keys:get-masked failed:', error);
      root.dataset.keyMaskedLoaded = 'error';
      if (keyStatusLine) keyStatusLine.textContent = `Key 状态：读取失败 ${String(error).slice(0, 80)}`;
    });
}

keySetForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!bridge || !keyProviderSelect || !keyInput) return;
  const provider = keyProviderSelect.value;
  const key = keyInput.value.trim();
  const baseUrl = keyBaseUrlInput?.value.trim() || undefined;
  const model = keyModelInput?.value.trim() || undefined;
  // FR-2.4 备用 Key：每行一把（≤5），空行忽略；随主 Key 同一加密纪律落库
  const backupKeys = (keyBackupInput?.value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (key.length < 8) {
    if (keyStatusLine) keyStatusLine.textContent = 'Key 状态：Key 至少 8 个字符，请检查输入。';
    root.dataset.keySet = 'invalid-input';
    return;
  }
  if (backupKeys.some((k) => k.length < 8) || backupKeys.length > 5) {
    if (keyStatusLine) keyStatusLine.textContent = 'Key 状态：备用 Key 每把至少 8 个字符且最多 5 把，请检查输入。';
    root.dataset.keySet = 'invalid-input';
    return;
  }
  root.dataset.keySet = 'pending';
  bridge
    .invoke('keys:set', {
      provider,
      key,
      ...(backupKeys.length > 0 ? { backupKeys } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    })
    .then((data) => {
      const result = data as { masked: string; encryption: string; warning?: string };
      root.dataset.keySet = result.warning ? 'warn' : 'done';
      if (keyStatusLine) {
        keyStatusLine.textContent = result.warning
          ? `Key 状态：已保存，但有告警——${result.warning}`
          : `Key 状态：已保存（${result.masked}）。`;
      }
      keyInput.value = '';
      refreshMaskedKeys();
    })
    .catch((error: unknown) => {
      root.dataset.keySet = 'failed';
      if (keyStatusLine) keyStatusLine.textContent = `Key 状态：保存失败——${String(error).slice(0, 140)}`;
      console.warn('[renderer] keys:set failed:', error);
    });
});

/* ---- 调用前确认 modal（FR-2.7③）：测试连接=真实外呼，先查 per-provider 会话内确认态 ---- */
let precallPendingProvider: string | null = null;

function closePrecallModal(confirmed: boolean): void {
  precallModal?.setAttribute('hidden', '');
  root.dataset.precallModal = 'closed';
  const provider = precallPendingProvider;
  precallPendingProvider = null;
  if (confirmed && provider) {
    bridge
      ?.invoke('keys:precall-confirm', { provider, action: 'confirm' })
      .then(() => {
        root.dataset.precallConfirm = 'confirmed';
        void runKeyTest(provider);
      })
      .catch((error: unknown) => {
        root.dataset.precallConfirm = 'failed';
        console.warn('[renderer] keys:precall-confirm failed:', error);
      });
  } else {
    root.dataset.precallConfirm = 'cancelled';
  }
}

async function runKeyTest(provider: string): Promise<void> {
  if (!bridge || !keyTestStatus) return;
  keyTestStatus.textContent = '测试中…';
  root.dataset.keyTest = 'pending';
  const baseUrl = keyBaseUrlInput?.value.trim();
  const model = keyModelInput?.value.trim();
  try {
    const result = (await bridge.invoke('keys:test', {
      provider,
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    })) as { ok: boolean; latencyMs: number | null; httpStatus: number | null; error: string | null };
    root.dataset.keyTest = result.ok ? 'ok' : 'failed';
    keyTestStatus.textContent = result.ok
      ? `测试连接：成功（${result.latencyMs ?? '?'}ms，HTTP ${result.httpStatus ?? '?'}）`
      : `测试连接：失败——${result.error ?? '未知错误'}`;
  } catch (error: unknown) {
    root.dataset.keyTest = 'blocked';
    keyTestStatus.textContent = String(error).slice(0, 160);
  }
}

keyTestBtn?.addEventListener('click', () => {
  if (!bridge || !keyProviderSelect) return;
  const provider = keyProviderSelect.value;
  root.dataset.precallConfirm = 'pending';
  bridge
    .invoke('keys:precall-confirm', { provider, action: 'check' })
    .then((data) => {
      const { needConfirm } = data as { needConfirm: boolean };
      if (needConfirm) {
        precallPendingProvider = provider;
        if (precallProviderLine) {
          precallProviderLine.textContent = `服务商：${KEY_PROVIDER_LABELS[provider] ?? provider}`;
        }
        precallModal?.removeAttribute('hidden');
        root.dataset.precallModal = 'open';
      } else {
        void runKeyTest(provider);
      }
    })
    .catch((error: unknown) => {
      root.dataset.precallConfirm = 'failed';
      if (keyTestStatus) keyTestStatus.textContent = String(error).slice(0, 160);
    });
});

precallConfirmBtn?.addEventListener('click', () => closePrecallModal(true));
precallCancelBtn?.addEventListener('click', () => closePrecallModal(false));

precallResetBtn?.addEventListener('click', () => {
  if (!bridge || !keyProviderSelect) return;
  const provider = keyProviderSelect.value;
  bridge
    .invoke('keys:precall-confirm', { provider, action: 'reset' })
    .then((data) => {
      const { needConfirm } = data as { needConfirm: boolean };
      root.dataset.precallReset = needConfirm ? 'reset' : 'failed';
      if (keyTestStatus) keyTestStatus.textContent = needConfirm ? '调用前提示状态已重置（下次调用会再次确认）。' : '';
    })
    .catch((error: unknown) => {
      root.dataset.precallReset = 'failed';
      console.warn('[renderer] keys:precall-confirm reset failed:', error);
    });
});

/* ---- 词库扫描验证（keys:scan-test）：命中留痕 keyword_hits（wordlist_version 随行） ---- */
scanTestBtn?.addEventListener('click', () => {
  if (!bridge || !scanTestInput || !scanTestResult) return;
  const raw = scanTestInput.value.trim();
  if (!raw) {
    scanTestResult.textContent = '请输入待扫描文本或关键词。';
    root.dataset.scanTest = 'invalid-input';
    return;
  }
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const params =
    lines.length > 1
      ? { keywords: lines }
      : { text: lines[0] ?? raw };
  root.dataset.scanTest = 'pending';
  bridge
    .invoke('keys:scan-test', params)
    .then((data) => {
      const result = data as {
        wordlistVersion: string;
        hits: Array<{ term: string; category: string | null; kind: string; source: string }>;
        persisted: number;
      };
      root.dataset.scanTest = 'done';
      root.dataset.scanTestVersion = result.wordlistVersion;
      root.dataset.scanTestHits = String(result.hits.length);
      scanTestResult.textContent =
        `词库 v${result.wordlistVersion}：命中 ${result.hits.length} 处（留痕 ${result.persisted} 行）——` +
        (result.hits.length === 0
          ? '未命中。'
          : result.hits.map((h) => `[${h.kind}${h.category ? `/${h.category}` : ''}] ${h.term}`).join('，'));
    })
    .catch((error: unknown) => {
      root.dataset.scanTest = 'failed';
      scanTestResult.textContent = `扫描失败：${String(error).slice(0, 140)}`;
      console.warn('[renderer] keys:scan-test failed:', error);
    });
});

// m1 todo 10：masked Key 状态初始拉取（设置页断言面；失败不阻断壳挂载）
refreshMaskedKeys();

/* ============================== 日志视图 + demo 任务（todo 11） ============================== */

interface TaskStepView {
  stepId: string;
  seq: number;
  status: string;
  output: unknown;
  checkpointAt: string | null;
}

interface TaskView {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  steps: TaskStepView[];
}

interface LogRowView {
  id: number;
  ts: string;
  createdAt: string;
  level: number;
  levelName: string;
  category: string;
  traceId: string | null;
  spanId: string | null;
  msg: string;
  payload: unknown;
}

const logsStatus = document.getElementById('logs-status');
const logsTable = document.getElementById('logs-table');
const logsTbody = document.getElementById('logs-tbody');
const logsRefresh = document.getElementById('logs-refresh');
const logsCategory = document.getElementById('logs-category-filter') as HTMLSelectElement | null;
const logsTrace = document.getElementById('logs-trace-filter') as HTMLInputElement | null;

function shortTrace(id: string | null): string {
  return id ? id.slice(0, 8) : '';
}

function renderLogRows(rows: LogRowView[]): void {
  if (!logsTbody || !logsTable || !logsStatus) return;
  logsTbody.textContent = '';
  for (const row of rows.slice(0, 50)) {
    const tr = document.createElement('tr');
    for (const cell of [
      new Date(row.ts).toLocaleTimeString(),
      row.category,
      row.levelName,
      shortTrace(row.traceId),
      shortTrace(row.spanId),
      row.msg.slice(0, 60),
    ]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    logsTbody.appendChild(tr);
  }
  logsTable.hidden = rows.length === 0;
  logsStatus.textContent = rows.length === 0 ? '（暂无日志）' : `最近 ${rows.length} 条（占位级视图，完整时间线归 M1+）`;
}

function refreshLogs(): void {
  if (!bridge) return;
  const params: Record<string, unknown> = { limit: 100, order: 'desc' };
  if (logsCategory?.value) params.category = logsCategory.value;
  const trace = logsTrace?.value.trim();
  if (trace) params.traceId = trace;
  bridge
    .invoke('logs:query', params)
    .then((data) => {
      const result = data as { rows: LogRowView[] };
      renderLogRows(result.rows);
      root.dataset.logsLoaded = '1';
    })
    .catch((error: unknown) => {
      console.warn('[renderer] logs:query failed:', error);
      if (logsStatus) logsStatus.textContent = `日志查询失败：${String(error).slice(0, 120)}`;
      root.dataset.logsLoaded = 'error';
    });
}

logsRefresh?.addEventListener('click', refreshLogs);
logsCategory?.addEventListener('change', refreshLogs);

const demoCreateBtn = document.getElementById('demo-task-create-btn');
const demoTaskStatus = document.getElementById('demo-task-status');
const demoTaskList = document.getElementById('demo-task-list');

function renderTasks(tasks: TaskView[]): void {
  // 摘要行 + 恢复按钮（suspended 态）
  if (!demoTaskStatus) return;
  if (tasks.length === 0) {
    demoTaskStatus.textContent = '尚未创建演示任务。';
    if (demoTaskList) demoTaskList.textContent = '';
    return;
  }
  demoTaskStatus.textContent = `共 ${tasks.length} 个演示任务，最新：${tasks[0]?.status ?? '-'}`;
  if (demoTaskList) {
    demoTaskList.textContent = '';
    for (const task of tasks.slice(0, 5)) {
      const line = document.createElement('p');
      line.className = 'demo-task-line';
      line.textContent = `${task.id.slice(0, 8)}… [${task.kind}] ${task.status} · ${task.steps.filter((s) => s.status === 'completed').length}/${task.steps.length || 3} 步完成`;
      if (task.status === 'suspended') {
        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.className = 'btn btn-ghost demo-task-resume';
        resumeBtn.dataset.taskId = task.id;
        resumeBtn.textContent = '恢复（按检查点续跑）';
        resumeBtn.addEventListener('click', () => {
          if (!bridge) return;
          void bridge
            .invoke('tasks:resume', { taskId: task.id })
            .then(() => refreshTasks())
            .catch((error: unknown) => console.warn('[renderer] tasks:resume failed:', error));
        });
        line.appendChild(resumeBtn);
      }
      demoTaskList.appendChild(line);
    }
  }
}

function refreshTasks(): void {
  if (!bridge) return;
  bridge
    .invoke('tasks:list')
    .then((data) => {
      const result = data as { tasks: TaskView[] };
      renderTasks(result.tasks);
      root.dataset.tasksLoaded = '1';
      root.dataset.tasksStatus = result.tasks[0]?.status ?? 'none';
    })
    .catch((error: unknown) => {
      console.warn('[renderer] tasks:list failed:', error);
      root.dataset.tasksLoaded = 'error';
    });
}

demoCreateBtn?.addEventListener('click', () => {
  if (!bridge) return;
  bridge
    .invoke('tasks:createDemo')
    .then(() => refreshTasks())
    .catch((error: unknown) => {
      console.warn('[renderer] tasks:createDemo failed:', error);
      if (demoTaskStatus) demoTaskStatus.textContent = `创建失败：${String(error).slice(0, 120)}`;
    });
});

function renderAppInfo(info: { appVersion: string; electronVersion: string; platform: string; contractVersion: string }): void {  const text = `v${info.appVersion} · electron ${info.electronVersion}`;
  const brandVer = document.getElementById('brand-ver');
  const sideVer = document.getElementById('sidebar-version');
  const topVer = document.getElementById('topbar-version');
  if (brandVer) brandVer.textContent = `v${info.appVersion}`;
  if (sideVer) sideVer.textContent = `${text} · ${info.platform} · ipc ${info.contractVersion}`;
  if (topVer) topVer.textContent = text;
  setHtmlFlag('appInfo', 'ok');
}

/** 挂载：移除骨架屏、显示壳、完成初始渲染 */
function mount(): void {
  skeletonEl?.remove();
  if (appEl) appEl.hidden = false;
  setHtmlFlag('appMounted', '1');
}

if (!bridge) {
  setHtmlFlag('bridge', 'missing');
}

mount();

// 工作流执行入口（占位按钮）：解锁态点击显示占位提示；锁定态已被 disabled（FR-1.6 置灰）
for (const entry of Array.from(document.querySelectorAll<HTMLButtonElement>('.workflow-entry[data-write-entry]'))) {
  entry.addEventListener('click', () => {
    const section = entry.closest<HTMLElement>('.view[data-view]');
    const msg = section?.querySelector<HTMLElement>('[data-entry-msg]');
    if (msg) msg.hidden = false;
  });
}

// 初始状态：主进程锁定状态机快照（无 license → locked，路由可达性不收缩）
refreshLicenseStatus();

// todo 9：EULA 首启确认门 + 遥测 opt-in（requiresConfirm → 弹窗 + 主进程路由锁生效）
refreshConsentState();

// todo 11：日志视图 + demo 任务初始拉取（占位级；失败不阻断壳挂载）
refreshLogs();
refreshTasks();

// m1 todo 11（T-M1-06）：市场洞察（闸门卡片 + 采集列表/CSV）与选品报告（八章节/图表/导出）
try {
  initInsightView();
} catch (error) {
  console.warn('[renderer] insight view init failed:', error);
}
try {
  initReportView();
} catch (error) {
  console.warn('[renderer] report view init failed:', error);
}

// m1 todo 12（FR-2.5/2.6）：用量面板（settings 视图内 usage-card）
try {
  initUsageView();
} catch (error) {
  console.warn('[renderer] usage view init failed:', error);
}

if (bridge) {
  bridge
    .invoke('app:info')
    .then((data) => {
      renderAppInfo(data as { appVersion: string; electronVersion: string; platform: string; contractVersion: string });
    })
    .catch((error: unknown) => {
      console.warn('[renderer] app:info failed:', error);
      setHtmlFlag('appInfo', 'error');
    });
}
