/**
 * 预加载脚本（02 §4.1：contextBridge 暴露白名单 API；§4.3：入参在 preload 侧用 zod 校验）。
 *
 * 安全约束（§11.2）：
 * - 不暴露 ipcRenderer 本体，只暴露 invoke/navigate 两个白名单门面 + contractVersion；
 * - 越权通道（不在 IPC_CHANNELS）在 preload 侧直接 reject（稳定错误码 E-IPC-*）；
 * - 沙箱 preload（sandbox: true）下不引用任何 Node 能力（require/process 不出现在本文件）；
 * - 入参先经共享 zod schema 校验，合法后才交给 ipcRenderer.invoke，主进程侧还会再校验一次。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CONTRACT_VERSION, IPC_CHANNELS, IPC_ERRORS, type IpcChannel, type ViewId } from './shared/channels';
import { channelParamsSchemas, type NavigateResult } from './shared/schemas';

function reject(code: string, detail: string): Promise<never> {
  return Promise.reject(new Error(`${code}: ${detail}`));
}

const bridge = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!(IPC_CHANNELS as readonly string[]).includes(channel)) {
      return reject(IPC_ERRORS.UNKNOWN_CHANNEL, `channel "${channel}" 不在 IPC 白名单`);
    }
    const schema = channelParamsSchemas[channel as IpcChannel];
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success) {
      return reject(IPC_ERRORS.INVALID_PARAMS, `channel "${channel}" 入参校验失败`);
    }
    return ipcRenderer.invoke(channel, parsed.data);
  },
  navigate(view: ViewId): Promise<NavigateResult> {
    return bridge.invoke('app:navigate', { view }) as Promise<NavigateResult>;
  },
});

// 唯一暴露面：window.xinglian（白名单 API，见 02 §4.1 预加载进程行）
contextBridge.exposeInMainWorld('xinglian', bridge);
