import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('adapters-1688', () => {
  it('exports PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBe('adapters-1688');
  });
});
