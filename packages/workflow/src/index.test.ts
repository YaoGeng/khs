import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';
import { runWorkflow, serialSteps, CircuitOpenAbortError } from './executor.js';

describe('workflow', () => {
  it('exports PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBe('workflow');
  });

  it('exports serial executor surface', () => {
    expect(typeof runWorkflow).toBe('function');
    expect(typeof serialSteps).toBe('function');
    expect(new CircuitOpenAbortError({ action: 'abort-no-retry' }).code).toBe('E-WORKFLOW-CIRCUIT-OPEN');
  });
});
