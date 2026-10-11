/**
 * 安全基线纯函数（不 import electron，保证可被 vitest 直接单测）。
 * 依据 02-系统架构设计.md §11.2：sandbox + contextIsolation + 禁用 nodeIntegration；
 * 02 §4.1 进程模型表：渲染进程 sandbox: true / contextIsolation: true。
 */
import { IPC_CHANNELS, NAV_VIEWS, type IpcChannel, type ViewId } from '../shared/channels';

export interface WebPreferencesBaseline {
  /** 上下文隔离：渲染进程 world 与 preload world 隔离（§11.2） */
  contextIsolation: true;
  /** 禁用 Node 集成：渲染进程无 require/process（§11.2「禁用 remote 模块」同一防线） */
  nodeIntegration: false;
  /** 沙箱：preload 仅能 require electron 受限子集（contextBridge/ipcRenderer 等） */
  sandbox: true;
  /** 预加载脚本编译产物路径（out/preload.js） */
  preload: string;
  /** webSecurity 保持默认开启（显式声明，防上游误关） */
  webSecurity: true;
  spellcheck: false;
}

/** webPreferences 基线。Object.freeze 防止运行时被篡改后开窗。 */
export function webPreferencesBaseline(preloadPath: string): WebPreferencesBaseline {
  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: preloadPath,
    webSecurity: true,
    spellcheck: false,
  });
}

/** 通道白名单判定（preload 与 ipcMain 兜底共用） */
export function isChannelAllowed(channel: string): channel is IpcChannel & string {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}

/** 九视图 id 判定（登录占位视图不在导航白名单内，属渲染进程本地路由） */
export function isViewId(value: string): value is ViewId {
  return (NAV_VIEWS as readonly string[]).includes(value);
}
