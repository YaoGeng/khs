import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('adapters-xhs', () => {
  it('exports PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBe('adapters-xhs');
  });
});
