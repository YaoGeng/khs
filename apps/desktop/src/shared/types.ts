/**
 * 渲染进程可见的类型（type-only，渲染 bundle 不携带 zod）。
 * 契约常量在 channels.ts，zod schema 在 schemas.ts。
 */
import type { ViewId } from './channels';
import type { AppInfoResult, NavigateResult } from './schemas';

/** window.xinglian —— contextBridge 暴露的白名单 API（02 §4.1 预加载进程职责行） */
export interface XinglianBridge {
  readonly contractVersion: string;
  /**
   * 白名单通道 invoke。越权通道（不在 IPC_CHANNELS）与非法入参（zod 校验不过）
   * 直接 reject，错误消息以稳定错误码开头（IPC_ERRORS）。
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  /** 九视图导航便捷封装 = invoke('app:navigate', { view }) */
  navigate(view: ViewId): Promise<NavigateResult>;
  /**
   * 订阅 main→renderer 推送通道（仅 PUSH_CHANNELS 白名单；越权通道直接 throw）。
   * 返回取消订阅函数（renderer 切面板时调用，停止帧转发）。
   */
  onPush(channel: string, listener: (payload: unknown) => void): () => void;
}

export type { AppInfoResult, NavigateResult, ViewId };

declare global {
  interface Window {
    xinglian?: XinglianBridge;
  }
}
