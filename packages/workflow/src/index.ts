/**
 * @xinglian/workflow —— 串行 DAG 执行器（T-M1-04①，m1-insight-plan todo 7）。
 * 纯 TS 包：时钟/等待/检查点/让位门/熔断态全部注入，不依赖 electron/cdp/fs。
 */
export const PACKAGE_NAME = 'workflow';

export * from './executor.js';
