# apps/desktop — Electron 客户端（业务引擎组合根）

## OVERVIEW

Electron 33 桌面客户端：小红书采集 → 本地 SQLite(+sqlite-vec) → LLM 洞察报告。主进程侧目录是全仓唯一允许组装业务引擎包（workflow/llm-gateway/agents/stealth-middleware/...）的位置。

## STRUCTURE

```
src/
├── main.ts        # 应用入口：生命周期、组合根装配
├── preload.ts     # contextBridge 白名单桥，只暴露 protocol 契约
├── main/          # ipc-core.ts(注册表) + 各服务：collect/license/key/report/security/window/store
├── tasks/         # machine.ts(XState 生命周期) + runner.ts(DAG) + collect-service.ts + state-mirror
├── store/         # better-sqlite3+drizzle+sqlite-vec；worker.ts utilityProcess 写入；migrations.ts
├── browser/       # CDP 连接/启动/检测/会话 —— 真实浏览器接管采集
├── compliance/    # EULA、遥测守卫/上报、wordlist v1 扫描
├── license/       # Ed25519 离线授权校验
├── logs/          # 日志流转
├── shared/        # channels.ts + schemas.ts（IPC 契约，与 packages/protocol 镜像）
├── renderer/      # 无框架 vanilla TS + echarts：insight/reportView/download + shell.css
└── types/         # d.ts（echarts-wordcloud 等）
e2e/               # Playwright _electron 直启 out/main.js；fixtures/ + helpers.ts
scripts/           # build/dist/run-tests/ensure-electron-abi/cold-start/pilot-real-collect
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| 新 IPC 通道 | shared/channels.ts + schemas.ts 定契约 → main/ipc-core.ts 加 deps 接口与 handler | 出入口都过 zod validate |
| 新任务类型 | tasks/runner.ts 注册 kind → tasks/<kind>-service.ts | 参考 collect-service.ts |
| 存储改动 | store/schema.ts + migrations.ts | 写操作必须经 store worker（handleStoreRequest） |
| 采集链路 | tasks/collect-service.ts + browser/ + stealth-middleware 配额 | 断点续跑用 KV remainder/processed 键 |
| 报告链路 | main/report-service.ts → @xinglian/agents generateReport → renderer/reportView.ts | 词云 echarts-wordcloud |
| BYOK 密钥 | main/key-service.ts（safeStorage 加密）+ llm-gateway | 密钥不出主进程 |

## CONVENTIONS

- 构建是自研 esbuild 管线（scripts/build.mjs）：4 入口（main / store-worker / preload / renderer）+ tsc noEmit 类型门禁；不是 tsc 直出，package.json `main` = out/main.js。
- native 模块（better-sqlite3、sqlite-vec）必须 external，且在 electron-builder.yml asarUnpack。
- 测试必须经 scripts/run-tests.mjs：Electron 二进制当 node 跑 vitest（ABI v130），前置自动 ensure-electron-abi。
- renderer 打包为 IIFE；echarts/lib alias 到 echarts/core 防双实例。
- e2e：Playwright `_electron.launch` 直启构建产物，1 worker、无重试、不下载浏览器。

## ANTI-PATTERNS

- 绕过 store worker 直写 SQLite。
- 步骤级状态进 XState（machine.ts 只收任务生命周期宏状态）。
- 裸跑 `vitest`（node ABI 与 Electron ABI 不一致必挂）。

## COMMANDS

```bash
pnpm --filter @xinglian/desktop build      # esbuild + tsc noEmit
pnpm --filter @xinglian/desktop typecheck
pnpm --filter @xinglian/desktop test       # ABI 自愈 → vitest → playwright e2e
pnpm --filter @xinglian/desktop dist       # NSIS 打包（npmmirror 镜像）
node scripts/cold-start.mjs                # NFR-1 冷启动门禁（p50 ≤ 3000ms，7 跑 5 过）
```
