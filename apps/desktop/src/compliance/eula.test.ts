/**
 * EULA 纯逻辑单测（todo 9 / FR-1.9）：版本比较纯函数、重确认判定、门态解析（四态矩阵）、
 * 版本 test seam。门态源 = consents 留痕行（store 查询出口形状）。
 */
import { describe, expect, it } from 'vitest';
import {
  EULA_PLACEHOLDER,
  EULA_VERSION_DEFAULT,
  compareEulaVersions,
  needsReconfirm,
  resolveEulaGate,
  resolveEulaVersion,
  type EulaConsentRow,
} from './eula';

function eulaRow(over: Partial<EulaConsentRow> = {}): EulaConsentRow {
  return {
    action: 'accepted',
    eulaVersion: EULA_VERSION_DEFAULT,
    telemetryConsent: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    ...over,
  };
}

describe('compareEulaVersions（EULA 版本比较纯函数）', () => {
  it('相等 → 0（含预发布段全等）', () => {
    expect(compareEulaVersions('0.1.0-draft', '0.1.0-draft')).toBe(0);
    expect(compareEulaVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('逐段数值比较（主 > 次 > 补丁优先级）', () => {
    expect(compareEulaVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareEulaVersions('0.2.0-draft', '0.1.0-draft')).toBe(1);
    expect(compareEulaVersions('0.1.1', '0.1.0-draft')).toBe(1);
    expect(compareEulaVersions('0.0.10', '0.0.9')).toBe(1);
  });

  it('预发布 < 正式版（semver：0.1.0 > 0.1.0-draft）', () => {
    expect(compareEulaVersions('0.1.0', '0.1.0-draft')).toBe(1);
    expect(compareEulaVersions('0.1.0-draft', '0.1.0')).toBe(-1);
  });

  it('无法解析的版本按字符串序兜底（相等性判定不受影响）', () => {
    expect(compareEulaVersions('final-2026', 'final-2026')).toBe(0);
    expect(compareEulaVersions('final-2026', '0.1.0-draft')).not.toBe(0);
  });
});

describe('needsReconfirm（版本变更重确认判定，FR-1.9）', () => {
  it('无确认记录 → 重确认（首启）', () => {
    expect(needsReconfirm(null, EULA_VERSION_DEFAULT)).toBe(true);
  });

  it('版本相等 → 不重确认；升级/降级/任意变更 → 重确认（方向无关，默认是「确认过的那版文本」）', () => {
    expect(needsReconfirm('0.1.0-draft', '0.1.0-draft')).toBe(false);
    expect(needsReconfirm('0.1.0-draft', '0.2.0-draft')).toBe(true);
    expect(needsReconfirm('0.2.0-draft', '0.1.0-draft')).toBe(true);
    expect(needsReconfirm('0.1.0-draft', '0.1.0')).toBe(true);
  });
});

describe('resolveEulaGate（留痕行 → 门态投影）', () => {
  const APP = EULA_VERSION_DEFAULT;

  it('无 eula 记录 → unconfirmed + requiresConfirm（首启）', () => {
    const state = resolveEulaGate({ appEulaVersion: APP, eulaRow: null, telemetryRow: null });
    expect(state.eulaStatus).toBe('unconfirmed');
    expect(state.requiresConfirm).toBe(true);
    expect(state.confirmedVersion).toBeNull();
    expect(state.confirmedAt).toBeNull();
    expect(state.rejectedAt).toBeNull();
    expect(state.telemetryConsent).toBe('unasked');
  });

  it('已确认当前版 → accepted + 不锁；时间戳/版本号原样透出（确认记录字段齐）', () => {
    const state = resolveEulaGate({
      appEulaVersion: APP,
      eulaRow: eulaRow({ eulaVersion: APP, createdAt: '2026-10-11T08:00:00.000Z' }),
      telemetryRow: eulaRow({ telemetryConsent: true }),
    });
    expect(state.eulaStatus).toBe('accepted');
    expect(state.requiresConfirm).toBe(false);
    expect(state.confirmedVersion).toBe(APP);
    expect(state.confirmedAt).toBe('2026-10-11T08:00:00.000Z');
    expect(state.telemetryConsent).toBe('granted');
  });

  it('已确认旧版 + 应用侧版本升级 → version-changed + 仍锁（旧记录存在但版本不匹配 → 重弹）', () => {
    const state = resolveEulaGate({
      appEulaVersion: '0.2.0-draft',
      eulaRow: eulaRow({ eulaVersion: '0.1.0-draft', createdAt: '2026-10-11T08:00:00.000Z' }),
      telemetryRow: null,
    });
    expect(state.eulaStatus).toBe('version-changed');
    expect(state.requiresConfirm).toBe(true);
    expect(state.confirmedVersion).toBe('0.1.0-draft');
  });

  it('拒绝当前版 → rejected + 仍锁 + rejectedAt 透出', () => {
    const state = resolveEulaGate({
      appEulaVersion: APP,
      eulaRow: eulaRow({ action: 'rejected', eulaVersion: APP, createdAt: '2026-10-11T09:00:00.000Z' }),
      telemetryRow: null,
    });
    expect(state.eulaStatus).toBe('rejected');
    expect(state.requiresConfirm).toBe(true);
    expect(state.rejectedAt).toBe('2026-10-11T09:00:00.000Z');
    expect(state.confirmedVersion).toBeNull();
  });

  it('拒绝旧版 + 版本升级 → version-changed（新版本重问）', () => {
    const state = resolveEulaGate({
      appEulaVersion: '0.3.0-draft',
      eulaRow: eulaRow({ action: 'rejected', eulaVersion: '0.1.0-draft' }),
      telemetryRow: null,
    });
    expect(state.eulaStatus).toBe('version-changed');
    expect(state.requiresConfirm).toBe(true);
  });

  it('遥测现值取 telemetry_consent 非空最新行：拒绝行（null）不覆盖既有开关', () => {
    const state = resolveEulaGate({
      appEulaVersion: APP,
      eulaRow: eulaRow({ telemetryConsent: null }),
      telemetryRow: eulaRow({ action: 'disabled', telemetryConsent: false }),
    });
    expect(state.telemetryConsent).toBe('denied');
  });

  it('未知动作行 → 保守按 unconfirmed（宁锁勿放）', () => {
    const state = resolveEulaGate({
      appEulaVersion: APP,
      eulaRow: eulaRow({ action: 'corrupted' }),
      telemetryRow: null,
    });
    expect(state.eulaStatus).toBe('unconfirmed');
    expect(state.requiresConfirm).toBe(true);
  });
});

describe('resolveEulaVersion（test seam：XINGLIAN_EULA_VERSION）', () => {
  it('默认取常量 draft 版本', () => {
    expect(resolveEulaVersion({})).toBe(EULA_VERSION_DEFAULT);
    expect(EULA_VERSION_DEFAULT).toBe('0.1.0-draft');
  });

  it('环境变量覆盖生效（e2e 升级重确认流注入；空白值回退默认）', () => {
    expect(resolveEulaVersion({ XINGLIAN_EULA_VERSION: '9.9.9-rc1' })).toBe('9.9.9-rc1');
    expect(resolveEulaVersion({ XINGLIAN_EULA_VERSION: '   ' })).toBe(EULA_VERSION_DEFAULT);
  });
});

describe('EULA 占位文本（PC-01 四段式 + 收集清单占位）', () => {
  it('四段式结构齐 + 隐私政策收集清单齐 + 标注占位与定稿卡', () => {
    for (const marker of ['一、平台协议风险告知', '二、用户承诺条款', '三、内容责任归属', '四、责任边界', '隐私政策']) {
      expect(EULA_PLACEHOLDER).toContain(marker);
    }
    for (const item of ['邮箱', '密码哈希', '订单', '设备指纹哈希', '遥测']) {
      expect(EULA_PLACEHOLDER).toContain(item);
    }
    expect(EULA_PLACEHOLDER).toContain('占位法律文本');
    expect(EULA_PLACEHOLDER).toContain('M6 T-M6-02');
  });
});
