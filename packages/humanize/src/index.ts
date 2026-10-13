/**
 * @xinglian/humanize —— 拟人节奏与操作层（T-M1-03，02 §7.1/§7.2）。
 * 纯函数包：随机性/时钟全部注入；CDP 注入由调用方执行，本包不依赖 electron/cdp。
 */
export const PACKAGE_NAME = 'humanize';

export * from './rng.js';
export * from './pacing.js';
export * from './humanizer.js';
