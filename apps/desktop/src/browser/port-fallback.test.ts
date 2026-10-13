/**
 * D6 fallback 纯校验逻辑单测（todo 10 = T-M0-08；S6 §3 预置降级分支，默认不启用、无 e2e）。
 */
import { describe, expect, it } from 'vitest';
import {
  checkPortExposure,
  hasGlobalWebSocket,
  isLoopbackAddress,
  isInProcessTree,
  parseDevToolsActivePort,
  parseNetstatRows,
  type NetstatRow,
} from './port-fallback';

describe('parseDevToolsActivePort（端口发现）', () => {
  it('首行为端口数字（S6 实测格式）', () => {
    expect(parseDevToolsActivePort('57781\n/devtools/browser/a3f9-2f')).toBe(57781);
    expect(parseDevToolsActivePort('60167\r\n/devtools/browser/x')).toBe(60167);
  });
  it('畸形内容返回 null（空/非数字/越界）', () => {
    expect(parseDevToolsActivePort('')).toBeNull();
    expect(parseDevToolsActivePort('not-a-port\nx')).toBeNull();
    expect(parseDevToolsActivePort('99999')).toBeNull();
    expect(parseDevToolsActivePort('0')).toBeNull();
  });
});

describe('parseNetstatRows + loopback 断言', () => {
  const NETSTAT = [
    '  连接专用信息',
    '  Proto  本地地址          远程地址          状态           PID',
    '  TCP    127.0.0.1:57781   0.0.0.0:0         LISTENING      12345',
    '  TCP    192.168.1.9:57781 0.0.0.0:0         LISTENING      999',
    '  TCP    127.0.0.1:57781   127.0.0.1:60167   ESTABLISHED    12345',
    '  UDP    0.0.0.0:5353      *:*                              4242',
  ].join('\r\n');

  it('解析 TCP 行；忽略表头/UDP/其他状态', () => {
    const rows = parseNetstatRows(NETSTAT);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ localAddr: '127.0.0.1', port: 57781, remote: '0.0.0.0:0', state: 'LISTENING', pid: 12345 });
  });

  it('isLoopbackAddress', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.9')).toBe(false);
  });
});

describe('checkPortExposure（仅 loopback + PID 树校验；S6 边界：只防串台，不防外来连接）', () => {
  const rows: NetstatRow[] = [
    { localAddr: '127.0.0.1', port: 49419, remote: '0.0.0.0:0', state: 'LISTENING', pid: 8836 },
  ];

  it('合法：唯一 LISTENING + loopback + pid 在集合内', () => {
    const check = checkPortExposure(rows, 49419, new Set([8836]));
    expect(check.ok).toBe(true);
    expect(check.listener?.pid).toBe(8836);
  });

  it('非 loopback 绑定被拒（S6：内核默认绑 127.0.0.1，此为防御性断言）', () => {
    const check = checkPortExposure([{ ...rows[0]!, localAddr: '0.0.0.0' }], 49419, new Set([8836]));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('非 loopback');
  });

  it('监听 pid 不在浏览器进程树 → 拒绝（防假浏览器/串台）', () => {
    const check = checkPortExposure(rows, 49419, new Set([1234]));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('不在浏览器进程树');
  });

  it('无监听 / 多条监听被拒', () => {
    expect(checkPortExposure([], 49419, new Set([1])).ok).toBe(false);
    const dup = [...rows, { localAddr: '127.0.0.1', port: 49419, remote: '0.0.0.0:0', state: 'LISTENING', pid: 8837 }];
    const check = checkPortExposure(dup, 49419, new Set([8836]));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('2 条 LISTENING');
  });
});

describe('isInProcessTree（S6 lib/util.mjs 同算法）', () => {
  const procs = [
    { pid: 1, ppid: 0, name: 'explorer.exe' },
    { pid: 100, ppid: 1, name: 'chrome.exe' },
    { pid: 200, ppid: 100, name: 'chrome.exe' },
    { pid: 300, ppid: 200, name: 'node.exe' },
    { pid: 400, ppid: 1, name: 'evil.exe' },
  ];

  it('子进程在树内（孙代也算）；孤儿/环安全', () => {
    expect(isInProcessTree(300, 100, procs)).toBe(true);
    expect(isInProcessTree(200, 100, procs)).toBe(true);
    expect(isInProcessTree(400, 100, procs)).toBe(false);
    expect(isInProcessTree(999, 100, procs)).toBe(false);
  });
});

describe('hasGlobalWebSocket（fallback 运行时判据）', () => {
  it('有全局 WebSocket 为 true；Node 20（Electron 33 主进程）为 false → E-BROWSER-FALLBACK-UNAVAILABLE 路径', () => {
    expect(hasGlobalWebSocket({ WebSocket: class {} })).toBe(true);
    expect(hasGlobalWebSocket({})).toBe(false);
  });
});
