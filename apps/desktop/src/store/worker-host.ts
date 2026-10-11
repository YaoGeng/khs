/**
 * utilityProcess transport（ADR-8 §7.1：唯一写者 = 写 worker）。
 * main 侧 binding：utilityProcess.fork → StoreTransport。薄壳，vitest 不 import 本文件（e2e 覆盖）。
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { StoreTransport } from './client';

export function createUtilityProcessTransport(workerPath: string, serviceName: string): StoreTransport {
  // XINGLIAN_STORE_WORKER=forked：worker 入口自启开关（隔离 vitest 纯核 import 路径）
  const child: UtilityProcess = utilityProcess.fork(workerPath, [], {
    serviceName,
    env: { ...process.env, XINGLIAN_STORE_WORKER: 'forked' },
  });
  let messageHandler: ((message: unknown) => void) | null = null;
  let exitHandler: ((info: { code: number | null }) => void) | null = null;
  child.on('message', (message: unknown) => {
    messageHandler?.(message);
  });
  child.on('exit', (code: number) => {
    exitHandler?.({ code });
  });
  return {
    send: (message: unknown) => {
      child.postMessage(message);
    },
    onMessage: (handler) => {
      messageHandler = handler;
    },
    onExit: (handler) => {
      exitHandler = handler;
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        // 已退出则忽略
      }
    },
  };
}
