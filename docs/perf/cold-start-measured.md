# 冷启动实测（C-3 / NFR-1）

> 依据：03-PRD与架构对齐审查报告.md 第 230 行（C-3 要求 M0 退出标准加入实测值）；
> 预算分解见 `docs/perf/cold-start-budget.md`；总预算对照 NFR-1 ≤3s（01-需求说明书.md 第 262 行）。
> 实测载体：todo 4（T-M0-02）Electron 九视图空壳，`apps/desktop/scripts/cold-start.mjs` 自动采样。

## 机器规格（2026-10-11 实测）

| 项 | 值 |
| --- | --- |
| CPU | Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz（6C12T） |
| 内存 | 31.9 GB |
| OS | Windows 11（Windows_NT 10.0.26200，win32） |
| 磁盘 | SSD（PowerShell Get-PhysicalDisk MediaType=SSD） |
| Electron | 33.4.11（未打包 dev 壳：`electron out/main.js`） |

## 判定协议

- **判定标准**：与预算基准机（i5/8G/SSD，01:262）**同档或以上规格**的机器上，冷启动 **p50 ≤ 3000ms 即 PASS**；实测机 i7-9750H/32G/SSD 高于基准机档位，符合判定前提。
- **样本量**：≥5 次取 p50（本次 n=7）。
- **计时口径**：主进程内 `process.hrtime.bigint()`——`T0` = main 入口被求值时刻；`readyMs` = T0 → app 'ready'；`totalMs` = T0 → 渲染窗口 `did-finish-load`（即任务卡要求的「app 'ready' 到 did-finish-load 的时间戳差」口径的扩展，含渲染加载全程）。`domReadyMs = totalMs - readyMs`。
- **采集方式**：main 进程在 `did-finish-load` 时 `console.log('[cold-start]', JSON.stringify({readyMs, domReadyMs, totalMs}))`，`scripts/cold-start.mjs` spawn Electron（`--cold-start-bench` 模式：样本打印后 150ms 自动退出）捕获 stdout 逐行解析；连续 7 次 spawn，每次独立进程。
- **复现命令**：`pnpm --filter @xinglian/desktop cold-start`（环境变量 `COLD_START_RUNS` / `COLD_START_BUDGET_MS` / `COLD_START_TIMEOUT_MS` 可调；样本另存 `out/cold-start-samples.json`）。

## 实测结果（n=7）

| run | readyMs | domReadyMs | totalMs |
| --- | --- | --- | --- |
| 1 | 49.60 | 316.05 | 365.65 |
| 2 | 40.38 | 276.48 | 316.87 |
| 3 | 41.12 | 285.04 | 326.16 |
| 4 | 39.12 | 328.68 | 367.79 |
| 5 | 54.13 | 288.56 | 342.69 |
| 6 | 48.18 | 388.86 | 437.04 |
| 7 | 53.03 | 336.26 | 389.29 |
| **p50** | **48.18** | **316.05** | **365.65** |
| min / max | 39.12 / 54.13 | 276.48 / 388.86 | 316.87 / 437.04 |

## 对照结论

| 对照 | 预算/阈值 | 实测 | 结论 |
| --- | --- | --- | --- |
| NFR-1 冷启动 ≤3s（01:262） | 3000ms | p50 **365.65ms** | ✅ PASS（余量 ~8.2×） |
| C-3 预算合计（cold-start-budget.md） | ≤1800ms | p50 365.65ms | ✅ PASS（余量 ~4.9×） |
| 招一：主进程延迟加载（预算 ≤600ms） | 600ms | readyMs p50 48.18ms（重模块统一延迟到 `did-finish-load` 后 `bootstrapAfterWindowReady()`，见 `src/main/lazy.ts`） | ✅ 远低于预算 |
| 招二：V8 snapshot（预算 ≤300ms） | 300ms | **评估不适用，见下** | ⚠️ 记录为不适用 |
| 招三：渲染首屏骨架（预算 ≤900ms） | 900ms | domReadyMs p50 316.05ms；骨架屏为 index.html 静态标记，JS 挂载前可见（`#boot-skeleton`，renderer 挂载后移除） | ✅ 远低于预算 |

### V8 snapshot 评估不适用（如实记录）

- **事实**：stock Electron（electron-builder 产出的官方二进制）**不支持应用级自定义 V8 startup snapshot**。V8 snapshot 是 embedder 级能力（v8.dev/blog/custom-startup-snapshots）；Electron 把自己的 snapshot 内嵌在二进制里，应用要用必须**覆盖官方 snapshot blob = 自建 Electron fork/定制构建**（VS Code 即走此路线）。社区实验（RaisinTen/electron-snapshot-experiment）亦确认：仅支持单文件快照、不支持 user-land 模块，属实验阶段。
- **依据来源**：v8.dev/custom-startup-snapshots（embedder API）；electron-userland/electron-builder#8797 与 electron-snapshot-experiment（Electron 下现状）；本地 GitHub 不可达，未能逐条在线复核 issue 现状，**注记待复核**。
- **处置**：M0 记「评估不适用」；**待 M5 T-M5-04 自动更新管线落地时**（届时已有自有构建/分发链路）重新评估是否引入定制 snapshot 构建。M0 内该预算项（≤300ms）从预算表让渡给实测余量——p50 365ms 相对 1800ms 总预算余量充足，不构成超支。
- **替代招已落**：主进程延迟加载 + 首屏静态骨架两项招实测生效（见上表）。

## 口径与偏离注记

1. **未打包 dev 壳**：实测对象是 `electron out/main.js`（esbuild 产物，非 asar）。与 asar 打包态的文件读取路径不同，asar 首启多一次 asar 头解析，通常差异在数十 ms 级；**M0 退出标准以本表 dev 壳实测为准**，门禁⑤（F3）如需 asar 态复测，用同脚本对 `dist/win-unpacked` 产物跑一次即可（脚本复用，改 `--cold-start-bench` 传参目标）。
2. **bundle 体积**：main.js/preload.js ~740KB（含 zod，IPC 契约两侧校验共用 schema，02 §4.3）。对冷启动影响已含在实测数内（did-finish-load 全程口径）。
3. **机器偏差**：实测机高于基准机档位。按判定协议（同档或以上 p50≤3s 即过）判定 PASS；若未来在低于 i5/8G/SSD 的机器复测而超支，按 todo 1 预算分解表逐项定位后转新实现行（计划 todo 4 验收条款）。
