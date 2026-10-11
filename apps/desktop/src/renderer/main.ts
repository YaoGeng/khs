/**
 * 渲染进程入口（纯 UI，02 §4.1：渲染进程不可直接访问文件/网络系统 API）。
 *
 * - 九视图导航：点击侧边栏 → window.xinglian.navigate(view)（app:navigate 通道，
 *   主进程 zod 校验 + 记录）→ 成功后切换 section；data-last-navigate 供 e2e 断言真实 IPC 往返。
 * - 登录占位：纯 DOM 本地路由，不发任何网络请求（M0 不接后端）。
 * - app:info：挂载后拉取壳层版本信息展示。
 * - 挂载完成即移除首屏骨架（C-3 招三），并在 html 上标记 data-app-mounted 供 e2e 等待。
 */
import type { ViewId } from '../shared/types';

const bridge = window.xinglian;

const appEl = document.getElementById('app');
const skeletonEl = document.getElementById('boot-skeleton');
const topbarTitle = document.getElementById('topbar-title');
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item[data-view]'));
const sections = Array.from(document.querySelectorAll<HTMLElement>('.view[data-view]'));
const root = document.documentElement;

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
        // 理论上九视图 id 都在白名单内；被拒说明契约被破坏——保守地仍切换视图但留下证据标记
        console.warn('[renderer] navigate rejected:', error);
        setHtmlFlag('lastIpc', 'rejected');
        localFallback(view);
      });
  });
}

const loginButton = document.getElementById('topbar-login');
const loginSection = document.getElementById('view-login');
loginButton?.addEventListener('click', () => {
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

function renderAppInfo(info: { appVersion: string; electronVersion: string; platform: string; contractVersion: string }): void {
  const text = `v${info.appVersion} · electron ${info.electronVersion}`;
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
