# packages/protocol — 唯一跨层契约通道

## OVERVIEW

app↔package、桌面双端唯一允许的共享契约包：采集 Flow DSL、适配器包 Ed25519 签名与 semver 兼容、词单契约。纯 zod schema + 纯函数，无 IO、无业务逻辑。

## STRUCTURE

```
src/
├── dsl.ts       # FlowSchema/StepSchema/SearchQuerySchema、planKeywordQueries（关键词规划）
├── signing.ts   # manifestSignablePayload、parseSemver/compareSemver/isEngineCompatible、SHA256_RE
├── wordlist.ts  # WordlistConfigSchema/WordlistManifestSchema、EXTREME_TERM_CATEGORIES、compareWordlistVersions
└── index.ts     # 汇出（PACKAGE_NAME）
```

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| 加/改 DSL 或 IPC 契约 | 本包 schema → apps/desktop/src/shared/schemas.ts 镜像同步 | 双端都要过验 |
| 适配器签名 | signing.ts + 根 scripts/adapter-sign.mjs（keygen/sign/verify） | 密钥在 .omo/secrets/adapter-dev-key/ |
| 词单格式 | wordlist.ts + apps/desktop/src/compliance/wordlist-* | 极限词/跳转词/类目黑名单三类 |

## CONVENTIONS

- 一律 zod strictObject；先 schema 后 `z.infer`，不手写重复类型。
- 全仓 12 个文件 import 本包，改动先 `pnpm --filter @xinglian/protocol build`，下游包（adapter-loader、adapters-xhs 等）测试读的是 dist/。
- 适配器激活验收门禁：根 scripts/adapter-activation-e2e.mjs（验签/篡改回滚/自检三段）。

## ANTI-PATTERNS

- 在本包加业务逻辑、IO 或依赖其他业务包 —— 它是依赖图最底层。
- app 绕过本包自定义跨层类型（eslint.boundaries 规则二只放行本包）。
