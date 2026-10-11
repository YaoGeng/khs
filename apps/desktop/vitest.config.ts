import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // src 顶层 *.test.ts 也会被根 vitest（apps/*/src/*.test.ts）覆盖到，两层配置都收
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
  },
});
