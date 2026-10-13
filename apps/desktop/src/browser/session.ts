/**
 * 受控浏览器会话状态机 + 让位标志 + 健康检测规则（todo 10 = T-M0-08；FR-3.4/3.5、FR-4.5）。
 *
 * 三态（FR-3.5 标题栏）：detached=未接管 / attached=已接管 / login-expired=登录失效。
 * 纯函数 + 纯类（无 IO），vitest 直测；browser-service 持有实例并落 UI/日志。
 *
 * 健康检测规则（M0 从简口径，见 notes-browser-m0.md §4）：
 * - 连接层：周期 CDP ping（Browser.getVersion）失败 = 连接丢失 → 崩溃联动；
 * - 会话层：受控目标页 URL 命中平台登录特征 = 登录失效 → 引导重登；
 *   用户完成登录后 URL 离开特征集 → 回到 attached（自动出坑，无需额外确认）。
 */

export const BROWSER_SESSION_STATES = ['detached', 'attached', 'login-expired'] as const;
export type BrowserSessionState = (typeof BROWSER_SESSION_STATES)[number];

export type BrowserSessionEvent =
  | { type: 'TAKEOVER_OK' }
  | { type: 'DISCONNECT'; reason: string }
  | { type: 'BROWSER_LOST'; reason: string }
  | { type: 'LOGIN_EXPIRED'; url: string }
  | { type: 'LOGIN_RECOVERED'; url: string };

const TRANSITIONS: Record<BrowserSessionState, Partial<Record<BrowserSessionEvent['type'], BrowserSessionState>>> = {
  detached: { TAKEOVER_OK: 'attached' },
  attached: {
    DISCONNECT: 'detached',
    BROWSER_LOST: 'detached',
    LOGIN_EXPIRED: 'login-expired',
  },
  'login-expired': {
    LOGIN_RECOVERED: 'attached',
    DISCONNECT: 'detached',
    BROWSER_LOST: 'detached',
    TAKEOVER_OK: 'attached',
  },
};

/** 纯函数判定：from + event → to；非法迁移返回 null（迁移合法性唯一真源，与任务机同风格） */
export function resolveSessionTransition(
  from: BrowserSessionState,
  event: BrowserSessionEvent,
): BrowserSessionState | null {
  return TRANSITIONS[from][event.type] ?? null;
}

/* ------------------------ 登录失效特征规则（M0 从简，文档化） ------------------------ */

/** 各平台登录态失效的 URL 特征（能演示失效引导的最小集；升级条款见 notes-browser-m0.md §4） */
export const LOGIN_EXPIRED_URL_RULES: Record<'xhs' | '1688', readonly { host: string; path: RegExp }[]> = {
  xhs: [
    { host: 'www.xiaohongshu.com', path: /^\/login/ },
    { host: '.xiaohongshu.com', path: /^\/login/ },
  ],
  '1688': [
    { host: 'login.1688.com', path: /./ },
    { host: 'member.1688.com', path: /^\/member\/login/ },
  ],
};

/** 判定目标页 URL 是否命中平台登录失效特征（规则从简：仅 URL 层，不做页面元素探测） */
export function isLoginExpiredUrl(url: string, platform: 'xhs' | '1688'): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return LOGIN_EXPIRED_URL_RULES[platform].some(
    (rule) => (host === rule.host || host.endsWith(rule.host)) && rule.path.test(parsed.pathname),
  );
}

/* ------------------------------ 让位标志（FR-4.5 M0 机制桩） ------------------------------ */

export type YieldSource = 'user-input' | 'manual' | 'e2e-hook';

/**
 * 人工输入让位标志（FR-4.5/02 §9.1 yielded 语义的 M0 简化实现）：
 * - M0 无业务自动化，落地为 状态标志 + UI 指示 + 机制测试钩子（简化程度如实记录于
 *   notes-browser-m0.md §5）；真实输入信号接线（CDP 页面监听/原生钩子）随 M1 首个工作流落地；
 * - 机制预留：automationYielded 时 whenAutomationAllowed() 挂起——M1 自动化动作队列在
 *   执行任何动作前 await 该门（本文件用简单 deferred 表达，不引 XState 子状态，S9 边界）。
 */
export class YieldFlag {
  private yieldedAt: string | null = null;
  private reason: string | null = null;
  private source: YieldSource | null = null;
  private readonly waiters: Array<() => void> = [];
  /** 让位触发计数（测试钩子：证明信号路径工作） */
  yieldCount = 0;

  get active(): boolean {
    return this.yieldedAt !== null;
  }

  snapshot(): { yielded: boolean; reason: string | null; source: YieldSource | null; since: string | null } {
    return { yielded: this.active, reason: this.reason, source: this.source, since: this.yieldedAt };
  }

  /** 置让位：已处于让位态时刷新来源与时间（幂等） */
  engage(source: YieldSource, reason: string, now: Date): void {
    if (this.active) return;
    this.yieldedAt = now.toISOString();
    this.reason = reason;
    this.source = source;
    this.yieldCount += 1;
  }

  /** 解除让位：唤醒全部等待中的自动化门 */
  release(): boolean {
    if (!this.active) return false;
    this.yieldedAt = null;
    this.reason = null;
    this.source = null;
    for (const wake of this.waiters.splice(0)) wake();
    return true;
  }

  /** M1 自动化动作入口：让位期间挂起，解除后放行 */
  whenAutomationAllowed(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
