import { defineConfig } from 'vitest/config';

// apps/server 测试布局（注意：块注释里不能出现 `**/`，glob 会提前闭合注释，这里一律用行注释）：
// - src/*.test.ts       纯冒烟（根 vitest.config.ts 的 include 也是它，保证根 vitest run 不依赖 DB）。
// - test/ 下的 *.test.ts 服务端单测 + supertest e2e，仅本包配置运行（带 embedded-postgres globalSetup）。
// - esbuild 不支持 decorator metadata，统一 tsconfigRaw 开 experimentalDecorators；DI 依赖显式 @Inject()。
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    include: ['src/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/vitest.setup.ts'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
