# PROJECT KNOWLEDGE BASE

**Generated:** 2026-10-14
**Commit:** 9ea7f2b
**Branch:** main

## OVERVIEW

星链·AI 选品营销工作台：Electron 桌面客户端（小红书笔记采集 → 本地 SQLite/sqlite-vec → LLM 洞察报告）+ NestJS 授权/会员服务端。pnpm + TypeScript monorepo，全中文文档驱动开发。

## STRUCTURE

```
./
├── apps/
│   ├── desktop/     # Electron 客户端；主进程侧目录是全仓唯一"业务引擎组合根"
│   ├── server/      # NestJS + Prisma 授权/会员/卡密服务（License、设备激活、遥测）
│   └── admin/       # 空占位包，仅 lint
├── packages/
│   ├── protocol/          # 唯一跨层契约通道：Flow DSL、Ed25519 适配器签名、wordlist 契约
│   ├── workflow/          # 自研 DAG 执行器（检查点/断点续跑）
│   ├── llm-gateway/       # BYOK LLM 网关：OpenAI 兼容调用链、能力分档、出站脱敏
│   ├── agents/            # 报告 Agent 编排（chapters/clustering/report-agent）
│   ├── humanize/          # 内容人性化改写
│   ├── stealth-middleware/  # 配额计数、熔断状态机、让位 yield、重试策略
│   ├── adapter-loader/    # 适配器热更包：验签→兼容→自检→激活/回滚
│   ├── adapters-xhs/      # 小红书平台适配器
│   ├── adapters-1688/     # 1688 平台适配器
│   └── logger/            # pino NDJSON 日志（横切豁免，app 可直接引用）
├── bench/       # 独立实验场，非 workspace 成员，勿引用、检索时排除
├── docs/        # adr/ perf/ spike/ + dev/工程规范.md（边界规则原文）
├── scripts/     # 仓库级脚本：adapter-sign / adapter-activation-e2e / tm101-diff-check / gen-card
├── .omo/        # 任务编排：plans/、evidence/(验收证据)、secrets/ 与 state/(不入库)
└── 01~09-*.md   # 需求/架构/评审/里程碑编号文档 —— 开发唯一事实源
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| 加 IPC 通道 | apps/desktop/src/shared/channels.ts + schemas.ts → main/ipc-core.ts | 契约双端镜像同步 |
| 加 LLM 供应商 | packages/llm-gateway/src/presets.ts | 同步 docs/adr/provider-matrix.md，用 probe 脚本验证 |
| 任务/采集编排 | apps/desktop/src/tasks/ | XState 只管任务生命周期，步骤归 runner |
| 本地 DB 变更 | apps/desktop/src/store/schema.ts + migrations.ts | 写路径必须走 store worker |
| 适配器热更 | packages/adapter-loader + scripts/adapter-sign.mjs | Ed25519 密钥在 .omo/secrets/ |
| 服务端 API | apps/server/src/ 模块目录 | schema 在 prisma/ |
| 合规/词单 | apps/desktop/src/compliance/ + packages/protocol/src/wordlist.ts | EULA、遥测守卫、wordlist v1 |
| 工程规则原文 | docs/dev/工程规范.md | 目录边界 / S9 / 任务卡四段式 |

## CODE MAP

（LSP 不可用；Refs 为 import 该包的文件数，是近似中心度，非精确引用计数）

| Symbol | Type | Location | Refs | Role |
|---|---|---|---|---|
| buildIpcRegistry / invokeIpcEntry | fn | apps/desktop/src/main/ipc-core.ts | — | IPC 注册表与调用汇合点 |
| taskMachine / spawnTaskActor | fn | apps/desktop/src/tasks/machine.ts | — | XState v5 任务生命周期状态机 |
| TaskRunner | class | apps/desktop/src/tasks/runner.ts | — | 步骤编排 / 断点续跑 |
| handleStoreRequest / startStoreWorker | fn | apps/desktop/src/store/worker.ts | — | utilityProcess SQLite 批量写（MAX_BATCH_ROWS=100） |
| LlmGateway | class | packages/llm-gateway/src/gateway.ts | 5 | OpenAI 兼容调用链 |
| PROVIDER_CAPABILITY_PRESETS / schemaInjectionForTier | const/fn | packages/llm-gateway/src/presets.ts | — | 能力分档 A/B/C 与注入降级链 |
| deidentifyAuthor / pseudonymizeAuthor | fn | packages/llm-gateway/src/deidentify.ts | — | 作者假名化（出站前） |
| generateReport | fn | packages/agents/src/report-agent.ts | 2 | 报告 Agent 主入口 |
| FlowSchema / planKeywordQueries | schema/fn | packages/protocol/src/dsl.ts | 12(包级) | 采集 Flow DSL 契约与关键词规划 |
| parseSemver / isEngineCompatible / manifestSignablePayload | fn | packages/protocol/src/signing.ts | 12(包级) | 适配器包签名与引擎兼容判定 |
| WordlistConfigSchema / compareWordlistVersions | schema/fn | packages/protocol/src/wordlist.ts | — | 词单契约与版本比较 |

## CONVENTIONS

- 全中文文档与注释；代码标识符英文。01~09 编号文档是唯一事实源；`02-系统架构设计.md` 的修改受 scripts/tm101-diff-check.mjs 白名单门禁（未授权段落改动 exit 1）。
- 任务卡四段式：完成报告必须含 产物/证据/自测/风险，证据落 `.omo/evidence/`，缺任一段判未通过。
- 跨包测试 import 兄弟包编译产物 dist/，多个包的 test 脚本会先构建依赖（如 workflow 的 test 先 build stealth-middleware）。改包后先 `pnpm -r build` 再跑下游测试。
- 根 vitest 只收 `apps/*/src/*.test.ts` + `packages/*/src/*.test.ts`（无 DB 依赖冒烟集）；server 的 test/** 需 embedded-postgres；desktop 测试需 Electron ABI。全部串行（fileParallelism:false）。
- 契约一律 zod strictObject，先 schema 后 type infer。

## ANTI-PATTERNS (THIS PROJECT)

- apps/* 之间互相 import（eslint.boundaries.mjs 规则一，error）。
- renderer/preload import 业务引擎包（规则二：只许 @xinglian/protocol；@xinglian/logger 横切豁免）。
- 业务引擎包在渲染层组装 —— 只允许 apps/desktop 主进程侧目录（main/tasks/store/compliance/license/browser/logs）。
- DAG 步骤级中间态建模进 XState（S9 边界：步骤状态归执行器内部）。
- 提交 `.omo/secrets/`、`.omo/state/`、`scripts/out/`、`apps/server/src/generated/`（均已 gitignore）。
- 文案用「永不上传」类绝对化措辞（PC-12 合规口径：统一为「不上传至星链服务器，仅直连你所配置的 LLM 服务商」）。
- 在 apps/desktop 裸跑 `vitest`（native 模块需 Electron ABI v130，必须走 scripts/run-tests.mjs）。

## UNIQUE STYLES

- 证据门禁脚本：exit 非零 + 写 JSON transcript 到 `.omo/evidence/`（adapter-activation-e2e、realrun-report ≤15 次请求硬上限）。
- 自愈式安装链：根 postinstall → ensure-electron-abi.mjs 用真实 SQLite 探测并按需为 Electron 33.4.11 重编 better-sqlite3。
- 中国镜像内置：electron/electron-builder/better-sqlite3 二进制走 npmmirror（.npmrc + dist.mjs，本机 GitHub 不可达）。

## COMMANDS

```bash
pnpm install         # postinstall 自动修 Electron ABI
pnpm ci:all          # lint + test + build（本仓唯一"CI"，无 .github/）
pnpm -r build        # 全量构建；改包后必跑（下游测试依赖 dist）

# 各 app/package 的专属命令（typecheck/dist/e2e/验收演示）见各自目录的 AGENTS.md
```

## NOTES

- 无云端 CI（无 .github/）；docker-compose.yml 仅开发期 pg+redis，测试路径刻意不用 Docker。
- bench/、dist/、release/ 含大量构建产物，代码检索时一律排除。
- git 未跟踪文件里混有运行产物（out/、test-results/），以 .gitignore 为准判断入库范围。
