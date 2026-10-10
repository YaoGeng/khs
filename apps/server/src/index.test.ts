import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('server', () => {
  it('smoke: exports PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBe('server');
  });
});
