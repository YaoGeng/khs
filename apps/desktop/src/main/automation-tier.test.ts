/**
 * 自动化档位单测（M2 产品卡③ = FR-12.7）。fake kv 直测：
 * 解析回落（缺失/损坏 → semi）、服务读写往返、setTier 审计日志。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOMATION_TIER,
  KV_AUTOMATION_TIER,
  createAutomationTierService,
  parseAutomationTier,
} from './automation-tier';

describe('parseAutomationTier（kv 原始值解析）', () => {
  it('缺失/null → 默认 semi', () => {
    expect(parseAutomationTier(null)).toBe(DEFAULT_AUTOMATION_TIER);
    expect(parseAutomationTier('')).toBe('semi');
  });

  it("'auto' → auto；损坏值/Buffer 形态", () => {
    expect(parseAutomationTier('auto')).toBe('auto');
    expect(parseAutomationTier('AUTO')).toBe('semi');
    expect(parseAutomationTier('{"tier":"auto"}')).toBe('semi');
    expect(parseAutomationTier(Buffer.from('auto', 'utf8'))).toBe('auto');
    expect(parseAutomationTier(Buffer.from('garbage', 'utf8'))).toBe('semi');
  });
});

describe('createAutomationTierService（kv 读写往返）', () => {
  function makeService() {
    const kv = new Map<string, string | Buffer>();
    const logged: Array<{ msg: string; payload: unknown }> = [];
    const service = createAutomationTierService({
      store: {
        whenReady: async () => 1,
        kvGet: async (key: string) => kv.get(key) ?? null,
        kvSet: async (key: string, value: string | Buffer) => {
          kv.set(key, value);
          return { set: true };
        },
      },
      logger: {
        userAction: (msg: string, payload: unknown) => {
          logged.push({ msg, payload });
        },
      },
    });
    return { service, kv, logged };
  }

  it('缺省读 = semi；setTier(auto) 落 kv 原始字符串并可读回', async () => {
    const { service, kv } = makeService();
    expect((await service.getTier()).tier).toBe('semi');
    expect((await service.setTier('auto')).tier).toBe('auto');
    expect(kv.get(KV_AUTOMATION_TIER)).toBe('auto');
    expect((await service.getTier()).tier).toBe('auto');
  });

  it('setTier 写审计日志（含红线提示文案）', async () => {
    const { service, logged } = makeService();
    await service.setTier('auto');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toBe('automation:tier-set');
    expect(logged[0]!.payload).toMatchObject({ tier: 'auto', note: expect.stringContaining('收藏/询盘') });
  });

  it('回切 semi 幂等', async () => {
    const { service } = makeService();
    await service.setTier('auto');
    await service.setTier('semi');
    expect((await service.getTier()).tier).toBe('semi');
  });
});
