/**
 * ipcMain 注册（electron 侧薄壳：注册逻辑与校验逻辑都在 ipc-core.ts 纯模块里，便于单测）。
 */
import { ipcMain } from 'electron';
import { buildIpcRegistry, invokeIpcEntry, type AppInfoDeps } from './ipc-core';

/** 进程生命周期内幂等：先移除旧 handler 再注册，防止重复注册抛错 */
export function registerIpcHandlers(deps: AppInfoDeps): void {
  const registry = buildIpcRegistry(deps);
  for (const channel of registry.keys()) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, payload: unknown) => {
      const result = invokeIpcEntry(registry, channel, payload);
      if (!result.ok) {
        // 稳定错误码前缀（E-IPC-*），渲染进程/e2e 据此断言越权与非法入参被拒
        throw new Error(result.message);
      }
      return result.data;
    });
  }
}
