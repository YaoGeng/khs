// 本文件为独立配置切片，已组合进根 eslint 配置（eslint.config.mjs）；保留独立文件以便规则单独演进。
// 目录边界规则：apps/* 之间禁止互相 import；跨层只允许经 packages/protocol。
// 依据：docs/dev/工程规范.md「目录边界」节；04-架构评审报告.md S9；02-系统架构设计.md §3.3。

export default [
  {
    // 规则一：apps/* 包之间禁止互相 import
    files: ['apps/*/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/*', '../apps/*', '*/apps/*'],
              message:
                '目录边界：apps/* 之间禁止互相 import。跨包共享请经 packages/protocol（见 docs/dev/工程规范.md「目录边界」）。',
            },
          ],
        },
      ],
    },
  },
  {
    // 规则二：app 渲染层/preload -> packages 一律禁止（跨层契约只经 packages/protocol + preload 白名单桥）
    // M1 分层细化（编排决策 D12，2026-10-13）：业务引擎包的组装只允许发生在主进程组合根
    // （apps/desktop 的 main/tasks/store/compliance/license/browser/logs 等非渲染目录），机读规则对
    // 渲染层与 preload 保持全禁。基础豁免：@xinglian/logger 是横切基础设施（pino NDJSON 管线，
    // 无业务语义），允许 app 直接引用（F2/Q4 规则层化；原文见 docs/dev/工程规范.md「目录边界」）。
    files: ['apps/*/src/renderer/**', 'apps/*/src/preload.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@xinglian/workflow',
                '@xinglian/llm-gateway',
                '@xinglian/agents',
                '@xinglian/humanize',
                '@xinglian/adapters-xhs',
                '@xinglian/adapters-1688',
                '@xinglian/adapter-loader',
                '@xinglian/stealth-middleware',
              ],
              message:
                '目录边界：渲染层/preload 跨层只允许经 packages/protocol 引用契约；业务引擎包只能在主进程组合根装配（见 docs/dev/工程规范.md「目录边界」M1 分层细化）。',
            },
          ],
        },
      ],
    },
  },
];
