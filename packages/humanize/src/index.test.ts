import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('humanize', () => {
  it('exports PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBe('humanize');
  });
});
