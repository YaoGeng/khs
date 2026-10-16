/**
 * 采集链路组合根绑定（m1-insight-plan todo 7 = T-M1-04③⑤⑥；main 进程装配，本文件
 * 是业务引擎包在组合根的唯一组装点之一——eslint.boundaries.mjs D12 放行目录）。
 *
 * 装配面：
 * - CircuitBreaker（stealth-middleware）：事件 emit → circuit_events 本地账本（store）+
 *   complianceService.sendTelemetry 唯一出口；onSuspend → 挂起全部 running 任务 + 桌面通知
 *   （FR-9.5：OPEN 不自动重试、不自动切代理——本绑定不触碰任何代理配置）；
 * - DailyQuotaLedger('collect')：kv_config 持久化（QuotaStore 适配），本地日 00:00 自动重置；
 * - 适配包：loadActivePackage（adapter-loader，engineVersion 注入 shared/engine-constants
 *   单一来源）；未激活时回退 @xinglian/adapters-xhs 内置 DSL（M1 dev 口径，warn 留痕）；
 * - 自动化：env XINGLIAN_COLLECT_FIXTURE → mock CDP（fixture 场景）；否则 browserService
 *   prepareAutomationTab（passive 让位监听注入）+ CdpAutomation（全部动作经
 *   whenAutomationAllowed 唯一入口）；
 * - 让位监视：YieldMonitor 轮询 __khs_yield__ → YieldClassifier → runner.yieldTask /
 *   runner.resume（静默 3s）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadActivePackage } from '@xinglian/adapter-loader';
import { xhsAdapterDsl } from '@xinglian/adapters-xhs';
import type { AdapterDsl } from '@xinglian/protocol';
import {
  AutomationWindow,
  CircuitBreaker,
  DailyQuotaLedger,
  YieldClassifier,
  type CircuitEvent,
  type QuotaStore,
} from '@xinglian/stealth-middleware';
import type { Logger } from '@xinglian/logger';
import type { StoreClient } from '../store';
import type { TaskRunner } from '../tasks';
import { CollectService, type CollectReportStepContext, type CollectTaskInput } from '../tasks/collect-service';
import type { ComplianceService } from '../compliance/compliance-service';
import type { CollectStatsResult } from '../shared/schemas';
import {
  CdpAutomation,
  XHS_ORIGIN,
  createFixtureAutomation,
  parseFixtureScenario,
  startYieldMonitor,
  type FixtureAutomation,
  type YieldMonitorHandle,
} from '../browser/automation';
import type { BrowserService } from '../browser/browser-service';
import { ENGINE_DSL_VERSION } from '../shared/engine-constants';

export interface CollectBindingDeps {
  readonly store: StoreClient;
  readonly runner: TaskRunner;
  readonly logger: Logger;
  /** 遥测唯一出口（main.ts 注入 complianceService；缺省无出口=仅本地账本） */
  readonly compliance?: Pick<ComplianceService, 'sendTelemetry'>;
  /** 桌面通知（Electron Notification 封装；组合根注入） */
  readonly notify?: (title: string, body: string) => void;
  /** `<userData>` 根（adapters 包目录 = <userData>/adapters） */
  readonly userDataDir: string;
  /** 真实 CDP 模式必注入（fixture 模式可省） */
  readonly browser?: Pick<BrowserService, 'prepareAutomationTab' | 'whenAutomationAllowed' | 'yieldToUser' | 'resumeFromYield'>;
  readonly now?: () => Date;
  /** 节奏缩放（env XINGLIAN_COLLECT_PACING_SCALE；生产 1） */
  readonly pacingScale?: number;
  /**
   * 报告步骤钩子（m1 todo 11 组合接线；main/report-service 提供）：
   * 提供则追加第 5 步 collect-report（报告生成 + awaiting_user 闸门）；
   * 缺省 = todo 7 四步管道原样（e2e/dev seam XINGLIAN_REPORT_STEP=off 时组合根不传）。
   */
  readonly reportStep?: (ctx: CollectReportStepContext) => Promise<unknown>;
  /** 爆款清单步骤钩子（M2 产品卡②；main/viral-service 提供）：finalize 后重算热度 TopN 快照 */
  readonly viralStep?: (ctx: CollectReportStepContext) => Promise<unknown>;
}

export interface CollectStartParams {
  inputType: 'keyword' | 'user' | 'note_url';
  topicId: string;
  terms?: string[];
  operator?: 'and' | 'or';
  keyword?: string;
  userUrl?: string;
  noteUrl?: string;
  targetTotal?: number;
}

export interface CollectBinding {
  readonly breaker: CircuitBreaker;
  readonly quota: DailyQuotaLedger;
  readonly service: CollectService;
  /** fixture 模式句柄（e2e/调试后门：simulateUserInput 等）；真实 CDP 模式为 null */
  readonly fixture: FixtureAutomation | null;
  start(params: CollectStartParams): Promise<{ taskId: string }>;
  /** 真实 CDP 自动化惰性建立（resume 路径前置：自动化会话不随 start 自动准备） */
  prepare(): Promise<void>;
  scanRemainders(): Promise<Array<{ taskId: string; topicId: string; remaining: number; dayKey: string; pausedAt: string; reason: string }>>;
  stats(runId: string, topicId?: string): Promise<{
    stats: Awaited<ReturnType<StoreClient['getCollectRunStats']>>;
    taskStatus: CollectStatsResult['taskStatus'];
    notesCount: number;
    snapshotsCount: number;
  }>;
  circuitStatus(): Promise<{
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    openedAt: string | null;
    cooldownMs: number;
    cooldownRemainingMs: number;
    events: Array<{ kind: string; at: string; meta: unknown }>;
  }>;
  confirmResume(): Promise<{ ok: boolean; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; reason?: string }>;
  shutdown(): void;
}

/** kv_config 持久化的 QuotaStore 适配（DailyQuotaLedger 注入面） */
function createKvQuotaStore(store: StoreClient): QuotaStore {
  return {
    async get(key: string) {
      const value = await store.kvGet(key);
      return typeof value === 'string' ? value : null;
    },
    async set(key: string, value: string) {
      await store.kvSet(key, value);
    },
  };
}

export function createCollectBinding(deps: CollectBindingDeps): CollectBinding {
  const now = deps.now ?? (() => new Date());
  const pacingScale = deps.pacingScale ?? 1;

  /* ---- 熔断器：事件 → 本地账本 + 遥测唯一出口；OPEN → 挂起全部 running + 通知 ---- */
  const breaker = new CircuitBreaker({
    now,
    emitter: {
      emit: (event: CircuitEvent) => {
        void deps.store
          .appendCircuitEvent({ kind: event.kind, at: event.at, meta: { reason: event.reason } })
          .catch(() => {});
        void deps.compliance?.sendTelemetry({ name: event.kind, payload: { reason: event.reason } }).catch(() => {});
      },
    },
  });
  const suspendAllRunning = async (reason: string): Promise<string[]> => {
    const running = await deps.store.listTasks('running');
    const suspended: string[] = [];
    for (const task of running) {
      const status = await deps.runner.suspend(task.id, reason);
      if (status === 'suspended') suspended.push(task.id);
    }
    return suspended;
  };
  breaker.onSuspend((notice) => {
    deps.notify?.('已熔断暂停', '检测到风控特征（验证码/限流），采集任务已全部挂起；请人工确认后再恢复。');
    deps.logger.systemError('circuit-open-tasks-suspended', { reason: notice.reason, at: notice.at });
    return suspendAllRunning(`circuit-open: ${notice.reason}`).then(() => {});
  });

  /* ---- 日配额账本（kv_config 持久化；本地日 00:00 按日期键自动重置） ---- */
  const quota = new DailyQuotaLedger({ kind: 'collect', store: createKvQuotaStore(deps.store), now });
  // pilot/dev seam：XINGLIAN_COLLECT_DAILY_LIMIT 下调日配额（≤50 保守联调口径；只能下调不可上调）
  const dailyLimitEnv = Number(process.env.XINGLIAN_COLLECT_DAILY_LIMIT ?? '');
  if (Number.isInteger(dailyLimitEnv) && dailyLimitEnv >= 1 && dailyLimitEnv <= quota.hardCap()) {
    void quota.setLimit(dailyLimitEnv).then(() => {
      deps.logger.networkMeta('collect:quota-limit', { limit: dailyLimitEnv, source: 'env:pilot-conservative' });
    }).catch(() => {});
  }

  /* ---- 适配包：active.json 加载链优先；未激活回退内置 xhs DSL（M1 dev 口径） ---- */
  const adapterHolder: { dsl: AdapterDsl } = { dsl: xhsAdapterDsl as unknown as AdapterDsl };
  void loadAdapterInBackground();
  async function loadAdapterInBackground(): Promise<void> {
    const adaptersRoot = join(deps.userDataDir, 'adapters');
    const publicKey = resolveAdapterPublicKey();
    if (!publicKey) {
      deps.logger.networkMeta('collect:adapter-fallback', {
        note: '未找到引擎公钥（dev seam XINGLIAN_ADAPTER_PUBKEY_FILE）；回退内置 xhs DSL',
      });
      return;
    }
    const result = await loadActivePackage({
      adaptersRoot,
      platform: 'xhs',
      engineVersion: ENGINE_DSL_VERSION,
      publicKey,
    });
    if (result.ok) {
      adapterHolder.dsl = result.dsl;
      deps.logger.networkMeta('collect:adapter-active', { version: result.version });
    } else {
      deps.logger.networkMeta('collect:adapter-fallback', {
        reason: result.reason,
        detail: result.detail.slice(0, 200),
        note: 'active 包未就绪；回退内置 xhs DSL（pilot 前须完成包激活，见 pilot-runbook）',
      });
    }
  }

  function resolveAdapterPublicKey(): string | Buffer | null {
    const envFile = process.env.XINGLIAN_ADAPTER_PUBKEY_FILE;
    if (envFile) {
      try {
        return readFileSync(envFile, 'utf8');
      } catch {
        return null;
      }
    }
    // dev 布局：<repo>/.omo/secrets/adapter-dev-key/adapter-dev-key-public.pem（不入库）
    const devKey = join(deps.userDataDir, '..', '..', '..', '.omo', 'secrets', 'adapter-dev-key', 'adapter-dev-key-public.pem');
    try {
      return readFileSync(devKey, 'utf8');
    } catch {
      return null;
    }
  }

  /* ---- 自动化：fixture seam（mock CDP）或真实 CDP（全部动作经 whenAutomationAllowed） ---- */
  const windows = new AutomationWindow();
  const classifier = new YieldClassifier({ window: windows });
  const fixturePath = process.env.XINGLIAN_COLLECT_FIXTURE ?? null;
  let fixture: FixtureAutomation | null = null;
  let realAutomation: CdpAutomation | null = null;
  let activeCollectTaskId: string | null = null;
  let yieldMonitor: YieldMonitorHandle | null = null;

  const realDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  if (fixturePath) {
    const scenario = parseFixtureScenario(readFileSync(fixturePath, 'utf8'));
    fixture = createFixtureAutomation(scenario, { delay: realDelay });
    deps.logger.networkMeta('collect:fixture-mode', { path: fixturePath, notes: scenario.notes.length, captcha: scenario.captcha });
  }

  function createAutomation() {
    if (fixture) return fixture;
    if (!deps.browser) throw new Error('E-COLLECT-AUTOMATION-UNAVAILABLE: 未接管浏览器且无 fixture 场景');
    if (!realAutomation) {
      throw new Error('E-COLLECT-AUTOMATION-UNAVAILABLE: 真实 CDP 会话须经 prepareAutomation 惰性建立');
    }
    return realAutomation;
  }

  async function prepareRealAutomation(): Promise<void> {
    if (fixture || realAutomation || !deps.browser) return;
    const session = await deps.browser.prepareAutomationTab();
    realAutomation = new CdpAutomation({
      connection: session.connection,
      sessionId: session.sessionId,
      gate: () => deps.browser!.whenAutomationAllowed(),
      windows,
      delay: realDelay,
      pollIntervalMs: Number(process.env.XINGLIAN_COLLECT_POLL_MS) || 200,
      waitForTimeoutMs: Number(process.env.XINGLIAN_COLLECT_WAIT_MS) || 10_000,
    });
    startYieldMonitorFor();
    // 冷会话预热（pilot 实测：恢复续跑首条详情在冷会话上导航 9.9s > NFR-1 单条预算 8s，任务被
    // 预算护栏打失败）：先开平台首页建立 DNS/TLS/连接，只开首页、不触碰任何采集动作。
    // 预热失败不阻断（采集步骤自带重试与降级路径）。
    try {
      await realAutomation.navigate(XHS_ORIGIN);
      await realAutomation.waitForFeature('body', 1);
      deps.logger.networkMeta('collect:warmup-ok', { origin: XHS_ORIGIN });
    } catch (error) {
      deps.logger.networkMeta('collect:warmup-skipped', { note: '预热失败不阻断', error: String(error).slice(0, 160) });
    }
  }

  /** FR-4.5 让位监视：窗口外输入 → yielded；静默 3s → resume（驱动循环不重启，动作续跑） */
  function startYieldMonitorFor(): void {
    if (yieldMonitor) return;
    const automation = fixture ?? realAutomation;
    if (!automation) return;
    yieldMonitor = startYieldMonitor({
      poll: () => automation.pollYieldFlag(),
      intervalMs: Number(process.env.XINGLIAN_YIELD_POLL_MS) || 500,
      classifier,
      delay: realDelay,
      onUserInput: () => {
        deps.browser?.yieldToUser('user-input', 'passive-input');
        if (activeCollectTaskId) {
          void deps.runner.yieldTask(activeCollectTaskId, 'user-input（让位，静默后自动恢复）').catch(() => {});
        }
      },
      onSilenceResume: () => {
        deps.browser?.resumeFromYield('silence-3s');
        if (activeCollectTaskId) {
          void deps.runner.resume(activeCollectTaskId).catch(() => {});
        }
      },
    });
  }

  /* ---- 采集服务（kind='collect' 注册进 runner；adapter 经 holder 提供者取实时值） ---- */
  const service = new CollectService({
    store: deps.store,
    runner: deps.runner,
    logger: deps.logger,
    createAutomation,
    adapter: () => adapterHolder.dsl,
    breaker,
    quota: {
      consume: (n?: number) => quota.consume(n ?? 1),
      remaining: () => quota.remaining(),
    },
    ...(deps.compliance ? { sendTelemetry: (event: { name: string; payload?: unknown }) => deps.compliance!.sendTelemetry(event) } : {}),
    ...(deps.notify ? { notify: deps.notify } : {}),
    ...(deps.reportStep ? { reportStep: deps.reportStep } : {}),
    ...(deps.viralStep ? { viralStep: deps.viralStep } : {}),
    now,
    pacingScale,
  });

  // fixture 模式：让位监视随绑定启动（e2e simulateUserInput → yielded → 静默恢复）
  if (fixture) startYieldMonitorFor();

  return {
    breaker,
    quota,
    service,
    fixture,
    async start(params: CollectTaskInput) {
      if (!fixture) await prepareRealAutomation();
      const taskId = await service.start(params);
      activeCollectTaskId = taskId;
      return { taskId };
    },
    prepare: prepareRealAutomation,
    scanRemainders: () => service.scanRemainders(),
    async stats(runId, topicId) {
      const base = await service.getStats(runId);
      const [notesCount, snapshotsCount] = await Promise.all([
        deps.store.listNotes(topicId ? { topicId, limit: 500 } : { limit: 500 }).then((rows) => rows.length),
        deps.store.countNoteSnapshots(topicId),
      ]);
      return {
        stats: base.stats,
        taskStatus: base.taskStatus as CollectStatsResult['taskStatus'],
        notesCount,
        snapshotsCount,
      };
    },
    async circuitStatus() {
      const snapshot = breaker.snapshot(now());
      const events = await deps.store.listCircuitEvents({ limit: 50 });
      return {
        state: snapshot.state,
        openedAt: snapshot.openedAt,
        cooldownMs: snapshot.cooldownMs,
        cooldownRemainingMs: snapshot.cooldownRemainingMs,
        events: events.map((e) => ({ kind: e.kind, at: e.at, meta: e.meta })),
      };
    },
    async confirmResume() {
      const state = breaker.state;
      if (state !== 'OPEN') {
        return { ok: false, state, reason: state === 'HALF_OPEN' ? '已处于 HALF_OPEN（可试探）' : '熔断未打开，无需确认恢复' };
      }
      const ok = breaker.confirmManualResume(now());
      return ok ? { ok, state: breaker.state } : { ok: false, state, reason: '冷却未期满（OPEN→HALF_OPEN 需冷却 30min 后人工确认）' };
    },
    shutdown() {
      yieldMonitor?.stop();
      yieldMonitor = null;
    },
  };
}
