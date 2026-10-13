import { describe, it, expect } from 'vitest';
import {
  PACKAGE_NAME,
  generateReport,
  ReportSchema,
  clusterTexts,
  M1_FIXTURE_NOTES,
  CHAPTER_IDS,
  KV_FIRST_REPORT_GENERATED,
} from './index.js';

describe('agents 出口面（todo 8：stub 变实）', () => {
  it('保留 PACKAGE_NAME 导出（既有消费面不回退）', () => {
    expect(PACKAGE_NAME).toBe('agents');
  });

  it('report-agent 关键面具名齐全（组合根接线所需）', () => {
    expect(typeof generateReport).toBe('function');
    expect(typeof clusterTexts).toBe('function');
    expect(typeof ReportSchema.parse).toBe('function');
    expect(KV_FIRST_REPORT_GENERATED).toContain('first_report_generated');
    expect(M1_FIXTURE_NOTES).toHaveLength(20);
    expect(CHAPTER_IDS).toHaveLength(8);
  });
});
