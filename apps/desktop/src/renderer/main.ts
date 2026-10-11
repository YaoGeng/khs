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
