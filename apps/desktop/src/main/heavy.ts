/**
 * 重模块占位注册点（M0）。M1+ 的 store / logger / browser-service / workflow-engine
 * （02-系统架构设计.md §4.2 模块清单）在此登记，由 lazy.ts 在窗口首帧后延迟加载。
 */
import type { HeavyModules } from './lazy';

export function loadHeavyModules(): HeavyModules {
  return { name: 'm0-placeholder' };
}
