/**
 * preload 源码守卫测试（§11.2：沙箱 preload 禁 Node 能力泄漏——静态源码断言）。
 * e2e（window.require/process undefined）验证运行时行为，本文件从源码层堵泄漏入口。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');

/** 去掉注释后做静态断言（注释里合法地出现 require/process 等词） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

const code = stripComments(source);

describe('preload 源码安全守卫', () => {
  it('不出现 require(...) 调用', () => {
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('不引用 process 全局', () => {
    expect(code).not.toMatch(/\bprocess\b/);
  });

  it('不 import 任何 node: 内置模块', () => {
    expect(code).not.toMatch(/from\s+['"]node:/);
  });

  it('唯一暴露面：恰好一次 exposeInMainWorld，名字为 xinglian', () => {
    expect(code.match(/exposeInMainWorld\(/g)?.length).toBe(1);
    expect(code).toMatch(/exposeInMainWorld\(\s*['"]xinglian['"]/);
  });

  it('不暴露 ipcRenderer 本体（仅经白名单门面使用）', () => {
    expect(code).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
  });

  it('所有通道引用都走 IPC_CHANNELS 常量（无散落通道字符串直调 invoke）', () => {
    expect(code).toMatch(/IPC_CHANNELS/);
  });
});
