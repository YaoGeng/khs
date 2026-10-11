import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './eslint.boundaries.mjs';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...boundaries
);
