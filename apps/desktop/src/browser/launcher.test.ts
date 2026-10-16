/**
 * 拉起参数红线单测（todo 10 = T-M0-08）：pipe 模式绝不携带调试端口参数（S6 选型核心理由）。
 */
import { describe, expect, it } from 'vitest';
import { assertNoPortArgs, buildLaunchArgs, pipeSpawnOptions } from './launcher';

const PROFILE = 'C:\\Users\\me\\AppData\\Local\\xinglian-workbench\\cdp-profiles\\xiaohongshu';

describe('buildLaunchArgs（S6 路线 A 配方）', () => {
  it('pipe 模式：含 --remote-debugging-pipe 与专用 --user-data-dir，绝无 --remote-debugging-port*', () => {
    const args = buildLaunchArgs({ profileDir: PROFILE, transport: 'pipe' });
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).toContain('--disable-sync');
    expect(args).toContain('--disable-extensions');
    expect(() => assertNoPortArgs(args)).not.toThrow();
  });

  it('port 模式（显式配置才存在）：--remote-debugging-port=0', () => {
    const args = buildLaunchArgs({ profileDir: PROFILE, transport: 'port' });
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).not.toContain('--remote-debugging-pipe');
  });

  it('M0 全链路 headful（不传 headless 开关）', () => {
    const args = buildLaunchArgs({ profileDir: PROFILE, transport: 'pipe' });
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false);
  });

  it('渲染节流三禁（occluded/renderer-background/timer-throttling）——遮挡窗 hydration 挂载根因修复', () => {
    const args = buildLaunchArgs({ profileDir: PROFILE, transport: 'pipe' });
    expect(args).toContain('--disable-backgrounding-occluded-windows');
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
  });

  it('stdio 五元组固定（fd3/fd4 = CDP 管道，协议要求）', () => {
    expect(pipeSpawnOptions().stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', 'pipe']);
  });
});
