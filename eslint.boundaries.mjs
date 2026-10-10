// 本文件为独立配置切片，由后续 todo 组合进根 eslint 配置；独立成文件以避免与并行建仓子任务冲突（计划修订注记）。
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
    // 规则二：app -> packages 只允许经 packages/protocol（其余 packages/* 一律禁止）
    files: ['apps/*/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@khs/workflow',
                '@khs/logger',
                '@khs/llm-gateway',
                '@khs/agents',
                '@khs/humanize',
                '@khs/adapters-xhs',
                '@khs/adapters-1688',
              ],
              message:
                '目录边界：跨层只允许经 packages/protocol 引用契约；业务包内部实现禁止被 app 直接 import（见 docs/dev/工程规范.md「目录边界」）。',
            },
          ],
        },
      ],
    },
  },
];
