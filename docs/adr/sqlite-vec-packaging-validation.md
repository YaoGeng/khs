# sqlite-vec + better-sqlite3 在 electron-builder asar 打包下的加载验证（M0 Spike S11）

> 任务：T-M0-06（计划 todo 5）· 依据：04-架构评审报告.md:94（S11：原生扩展 asar 加载路径 + Win/macOS 预编译产物，须 M0 打包管线验证）、02-系统架构设计.md:143（§3.1 本地向量检索选型行）
> 日期：2026-10-11 · 平台：Windows 11（Win 必做项已覆盖；macOS 本机不可得，未测——见 §6 风险）
> **结论：可行 ✅**——better-sqlite3（electron ABI 130 预编译）+ sqlite-vec v0.1.9 在 electron-builder asar 包内加载并完成 KNN 实测，退出码 0。发现两处必须写进 M1 store 实现规范的关键细节（§3）。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| OS / Node（宿主） | Windows 11（10.0.26200）/ node v24.6.0 |
| Electron | 33.4.11（内置 Node 20.18.3，**electron ABI = 130**） |
| better-sqlite3 | 12.4.1（@electron/rebuild 换用 electron-v130 预编译；宿主 Node 装的是 node-v137） |
| sqlite-vec | 0.1.9（平台包 sqlite-vec-windows-x64，vec0.dll 289KB） |
| electron-builder | 25.1.8（asar: true，target=dir） |
| 内置 SQLite | 3.50.4（better-sqlite3 捆绑） |

网络背景：GitHub 直连不可达，全部二进制经 npmmirror 镜像获取——镜像可用性已核：`better-sqlite3-v12.4.1-electron-v130-win32-x64.tar.gz`（HTTP 200，1,025,139 B）、`electron-v33.4.11-win32-x64.zip`（HTTP 200，115,028,145 B）。

## 2. 可重复运行步骤

沙箱目录 `bench/sqlite-vec-electron/`（自带 package.json，**不在 pnpm workspace globs 内**，pnpm 不会触碰；用 npm 管理，与 workspace 依赖隔离）：

```powershell
cd bench/sqlite-vec-electron

# 1) 安装（镜像 env 必设：GitHub 不可达）
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
$env:npm_config_electron_mirror = "https://registry.npmmirror.com/-/binary/electron/"
$env:npm_config_better_sqlite3_binary_host_mirror = "https://registry.npmmirror.com/-/binary/better-sqlite3"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npm install          # 实测 433 包，退出码 0

# 2) asar 打包（target=dir）。electron-builder 自动执行 @electron/rebuild
#    （log: "executing @electron/rebuild electronVersion=33.4.11 buildFromSource=false"）
#    → prebuild-install 经上述镜像拉取 electron-v130 预编译包，无需源编译
npm run pack         # 实测退出码 0（签名缺失自动跳过："no signing info identified, signing is skipped"）

# 3) 运行打包产物；main.js 加载扩展 → vec_version() → KNN 冒烟 → 写 pack-result.json 后退出
.\release\win-unpacked\sqlite-vec-bench.exe   # 实测退出码 0
Get-Content .\release\win-unpacked\pack-result.json
```

electron-builder.yml 关键配置：

```yaml
asar: true
asarUnpack:
  - node_modules/better-sqlite3/**
  - node_modules/sqlite-vec/**
  - node_modules/sqlite-vec-windows-x64/**   # 见 §3-③：npm 下该平台包嵌套安装
```

## 3. 关键发现（M1 store 实现必须遵循）

### ① better-sqlite3 的 .node 加载：asar 透明，无需处理

Node 的 `process.dlopen` 在 Electron 中会把 `app.asar` 路径自动重映射到 `app.asar.unpacked`——`require('better-sqlite3')` 的 resolve 结果虽显示 asar 虚拟路径，实际 `.node` 二进制从 unpacked 目录加载成功（pack-result.json 中 `betterSqlite3NativeExists: true`）。

### ② sqlite-vec 的 .dll 加载：**必须手动改写 app.asar → app.asar.unpacked**

sqlite-vec 的 `getLoadablePath()` 返回 asar 虚拟路径，但 `db.loadExtension(path)` 走的是 SQLite/Win32 `LoadLibrary`，**不经过 Node 的 dlopen 重映射**——直接传 asar 路径报 `SqliteError: 找不到指定的模块`（首次打包实测复现）。M1 store 必须封装：

```ts
import { app } from 'electron';
import sqliteVec from 'sqlite-vec';

function vecLoadablePath(): string {
  const p = sqliteVec.getLoadablePath();
  // 仅打包态需要改写；unpackaged 态路径本就在磁盘
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p;
}
db.loadExtension(vecLoadablePath());
```

实测成功产物内路径：`...\resources\app.asar.unpacked\node_modules\sqlite-vec\node_modules\sqlite-vec-windows-x64\vec0.dll`。

### ③ npm 下 sqlite-vec-windows-x64 嵌套安装，asarUnpack 递归通配已覆盖

`sqlite-vec-windows-x64` 是 sqlite-vec 的 optionalDependency，npm 实测将其装在 `node_modules/sqlite-vec/node_modules/sqlite-vec-windows-x64/`（嵌套）。`asarUnpack: node_modules/sqlite-vec/**` 的递归通配已把它一并解包（pack-result.json `loadablePathInsideUnpacked: true`）。**风险注记**：若未来改用 pnpm 安装沙箱（pnpm 的符号链接布局 + asar 打包行为不同），该路径假设需重新验证——workspace 内目前未将 sqlite-vec 列为依赖，M1 落 store 时必须重跑本验证。

### ④ rowid 绑定陷阱：better-sqlite3 把 JS number 绑成 REAL，vec0 拒收

实测（debug-insert.js，两运行时一致）：`typeof(?)` 对 JS `1` 返回 **real**，对 `BigInt` 返回 integer。vec0 插入 REAL rowid 报 `Only integers are allows for primary key values on <table>`。结论（写进 §4.2 嵌入缓存注记）：

- 显式 rowid 用 **BigInt**（`insert.run(BigInt(1), buf)`）或 SQL 字面量（`VALUES (1, ?)`）；
- 或干脆省略 rowid 用自增（`INSERT INTO vec_tbl(embedding) VALUES (?)`）。

### ⑤ ABI 匹配链路（pack 日志证据）

`@electron/rebuild ... buildFromSource=false → prebuild-install` 经 `npm_config_better_sqlite3_binary_host_mirror` 镜像取 electron-v130 预编译包，无需本地 VS BuildTools。宿主 Node 直接跑 workspace node_modules 的 better-sqlite3 用的是 node-v137（两套预编译并存、互不干扰）。

## 4. 打包产物布局证据

```
release/win-unpacked/
├─ sqlite-vec-bench.exe                 （启动后 APP_EXIT=0）
└─ resources/
   ├─ app.asar                          582,258 B —— 仅 JS/JSON；asar list 确认内无 vec0.dll / better_sqlite3.node
   └─ app.asar.unpacked/
      └─ node_modules/
         ├─ better-sqlite3/build/Release/better_sqlite3.node   1,896,960 B
         └─ sqlite-vec/node_modules/sqlite-vec-windows-x64/vec0.dll   289,280 B
```

pack-result.json（完整留档 `.omo/evidence/mvp0-dev-plan/sqlite-vec-pack-result.json`）关键字段：

```json
{
  "isPackaged": true, "electron": "33.4.11", "nodeInElectron": "20.18.3", "electronAbi": "130",
  "loadablePathInsideUnpacked": true,
  "vecVersion": "v0.1.9", "sqliteVersion": "3.50.4",
  "knnTopRow": { "rowid": 1, "distance": 0 },
  "ok": true
}
```

## 5. fallback 评估（S11 的"不可行预案"）

**无需启用**——主路径（electron-builder asar + asarUnpack）验证可行。备忘两条备用线，供未来升级 Electron 时评估：

1. **@electron/rebuild buildFromSource**：若未来 Electron ABI 在镜像上无预编译包（如新 ABI 未同步），设 `buildFromSource=true` 源编译 better-sqlite3——代价是构建机需 VS BuildTools + Python，打包时间显著增加。
2. **node:sqlite（Node 内置）**：Electron 33 内置 Node 20 无此模块（Node 22+ 才有）；Electron ≥ 37（Node 22+）后可作替代，但与 drizzle/better-sqlite3 生态兼容性需另评。**M5 自动更新升级 Electron 版本时必须重跑本验证**（届时 ABI 变化）。

## 6. 范围与风险

- **macOS 未测**（本机不可得）：asarUnpack/dlopen 机制同构，风险主要在 dylib 路径与签名（ hardened runtime 下 dylib 加载需签名/ entitlements）——按 04:94"macOS 有条件则补"，留待有 macOS 环境时补测；M5 notarize 前（todo 1 的 packaging-status.md 已注记）必须覆盖。
- 沙箱用 npm 直装，与 workspace 隔离；workspace 内 M1 落地时（store 引 better-sqlite3+sqlite-vec）需在 pnpm 布局下复跑一次本验证（§3-③注记）。
- 复现脚本与产物：`bench/sqlite-vec-electron/{main.js,electron-builder.yml,debug-insert.js,pack.log,install.log}`（node_modules/release 已 gitignore）。

## 7. pnpm 布局复验（M1）

> 任务：m1-insight-plan todo 2（§3-③:78-80 注记的强制复跑义务，§6:128 关闭项）· 日期：2026-10-13 · 平台：Windows 11（10.0.26200），Win 必做项完成；macOS 仍按 :127「有条件则补」口径留待。
> **结论：pnpm 布局下同样可行 ✅，`replace('app.asar','app.asar.unpacked')` 的 asPath 替换规则（§3-②）原样可用、无需调整。**唯一实质差异在包内内容物布局：pnpm 虚拟 store（`node_modules/.pnpm/`，符号链接）经 electron-builder 25.1.8 打包后，`sqlite-vec-windows-x64` 被提升为 **asar 内 node_modules 顶层**目录（实测 raw 路径 `...\app.asar\node_modules\sqlite-vec-windows-x64\vec0.dll`），不再是 npm 布局的 `node_modules\sqlite-vec\node_modules\sqlite-vec-windows-x64\`（:76）。M0 的 asarUnpack 通配三行原样命中，无需改动。

### 7.1 环境与依赖声明

| 项 | 值 | 与 M0（§1）对照 |
|---|---|---|
| 沙箱 | `bench/sqlite-vec-pnpm/`（独立工程，pnpm 安装；**交付 pnpm-lock.yaml，无 package-lock.json**——与 M0 的核心差异即此） | 同目录结构，包管理器换 pnpm |
| pnpm | 12.11.2（virtual store = `node_modules/.pnpm/`；内容寻址 store 硬链接） | M0 用 npm 平铺 |
| Electron / ABI | 33.4.11 / **130**（与 workspace `apps/desktop` devDep `electron: ^33` 实装 33.4.11 一致，沙箱显式锁同版保证可比） | 同版本同 ABI |
| better-sqlite3 | 12.4.1（workspace 同版本；@electron/rebuild→electron-v130 预编译，:91 链路） | 同版本（.node 1,896,960 B 与 M0 相同） |
| sqlite-vec | 0.1.9（平台包 sqlite-vec-windows-x64，vec0.dll 289,280 B 同 M0） | 同版本 |
| electron-builder | 25.1.8（target=dir） | 同版本 |
| vec0 表维度 | `float[1024]` 占位——**N 以 T-M1-01 ADR-7 锁定的默认档为准，本验证只证加载与 KNN 通路**（加载/KNN 与 dim 无关；默认档候选见 provider-matrix.md §4.2：bge-m3=1024/zhipu=2048/openai=1536） | M0 为 float[4] |

依赖声明收口：`apps/desktop/package.json` dependencies 新增 `sqlite-vec: 0.1.9`。此前 workspace 既未声明该依赖、pnpm-lock.yaml 里也没有它（`node_modules/.pnpm` 下的同版本目录只是 M0 期的本地残迹）；经本 todo 显式声明 + 根 `pnpm install`（Packages +2）后入 lockfile，M1 store 引用自此有依赖事实。`pnpm audit --prod` 退出码 0，未引入漏洞。

### 7.2 命令与退出码表

| # | 命令（cwd） | 退出码 | 备注 |
|---|---|---|---|
| 0 | `pnpm -r lint`（仓库根，开工基线） | 0 | 三 workspace 应用 eslint 全绿 |
| 1a | `pnpm install`（bench/sqlite-vec-pnpm，首次） | **1（ERR_PNPM_IGNORED_BUILDS）** | pnpm ≥12 默认禁跑依赖生命周期脚本：electron/better-sqlite3 的 install 脚本被忽略并以退出码 1 拒绝 |
| 1b | `pnpm install --allow-build=electron --allow-build=better-sqlite3`（同目录） | 0 | pnpm 12.7+ 非交互批准（pnpm 12 已不再读 package.json#pnpm 字段），选择项写入沙箱 pnpm-workspace.yaml 的 `allowBuilds`；electron dist 经 npmmirror 下载、better-sqlite3 node ABI 预编译落位。M1 侧无此坑：仓库根 pnpm-workspace.yaml 本就带 allowBuilds（electron/better-sqlite3: true） |
| 2 | `pnpm run pack`（同目录；pnpm 下 `pnpm pack` 是内置命令，脚本必须 `pnpm run pack`） | 0 | @electron/rebuild electronVersion=33.4.11 buildFromSource=false，prebuild-install 经镜像拉 electron-v130 预编译（同 :37）；"no signing info identified, signing is skipped" |
| 3 | `.\release\win-unpacked\sqlite-vec-pnpm-bench.exe`（happy：asPath 重写生效） | **0** | pack-result.json `ok: true`、`loadablePathInsideUnpacked: true` |
| 4 | 同 exe，`SQLITEVEC_BENCH_MODE=raw-path`（failure QA：故意绕过 asPath 重写传 raw 路径） | **1（预期失败）** | `SqliteError: 找不到指定的模块。`（:62 同款失败签名）——证明验证有效（重写不是摆设） |
| 5 | 同 exe 复跑（重写还原） | **0** | 恢复验证 |
| 6 | `pnpm install`（仓库根，声明 sqlite-vec 后刷 lockfile） | 0 | Packages +2；root postinstall `ensure-electron-abi.mjs`（desktop scripts）自动换装 electron-v130 |
| 7 | `pnpm --filter @xinglian/desktop lint` | 0 | |
| 8 | `pnpm --filter @xinglian/desktop test`（esbuild build→vitest（ELECTRON_RUN_AS_NODE，Electron 内置 Node 执行 better-sqlite3 ABI 130）→Playwright e2e 26 例） | 0 | 零回退 |
| 9 | `pnpm -r lint`（回归复核） | 0 | |
| 10 | `pnpm audit --prod`（仓库根） | 0 | "No known vulnerabilities found"（sqlite-vec 0.1.9 无已知漏洞） |

镜像 env 沿用 M0（GitHub 不可达 :18）：ELECTRON_MIRROR / npm_config_electron_mirror / npm_config_better_sqlite3_binary_host_mirror / ELECTRON_BUILDER_BINARIES_MIRROR 均指 npmmirror；沙箱 .npmrc 与命令 env 双保险。

### 7.3 pnpm 布局实测路径（关键差异项）

- **unpackaged（未打包 dev 态）**：`getLoadablePath()` 返回 virtual store 实体路径，如 `...\bench\sqlite-vec-pnpm\node_modules\.pnpm\sqlite-vec-windows-x64@0.1.9\node_modules\sqlite-vec-windows-x64\vec0.dll`（workspace 内 `apps/desktop` 同构：`...\khs\node_modules\.pnpm\sqlite-vec-windows-x64@0.1.9\...`——文件实体在内容寻址 store 的硬链接里，符号链接 realpath 后直达）。未打包态本就不需要 asPath 重写（:70 「仅打包态需要改写」不变）。
- **packaged（asar）实测**：
  - raw：`...\release\win-unpacked\resources\app.asar\node_modules\sqlite-vec-windows-x64\vec0.dll`（**顶层提升，非嵌套**；M0 为 `...\app.asar\node_modules\sqlite-vec\node_modules\sqlite-vec-windows-x64\vec0.dll`）。
  - asPath 重写后：`...\release\win-unpacked\resources\app.asar.unpacked\node_modules\sqlite-vec-windows-x64\vec0.dll`，实测 `loadablePathInsideUnpacked: true`、`loadablePathOnDiskExists: true`。
- app.asar（338 目录项）内：sqlite-vec 本体 JS（index.cjs/index.mjs/package.json）**留在 asar 虚拟 fs 内未进 unpacked**（require 从 asar 直读，无碍）；app.asar.unpacked/node_modules 顶层实测仅两棵树：`better-sqlite3/`（build/Release/better_sqlite3.node）、`sqlite-vec-windows-x64/`（package.json、vec0.dll）。
- 运行时断言全绿：electron ABI 130、vec0 v0.1.9、SQLite 3.50.4、BigInt rowid 插入 5 行、KNN `MATCH ? ORDER BY distance LIMIT 3` top3 = rowid `[1, 2, 3]`、距离均有限（`[0, 0.6324555, 0.8944272]`）。顺带一条 M1 实现小注：vec0 KNN 返回的 `distance` 是**欧氏距离 L2 本身（非平方）**（0.6324555=√0.4、0.8944272=√0.8，与 M0 仅记 d=0 的口径互补）。
- 完整留档：`.omo/evidence/m1-insight-plan/`（`pack-result-pnpm.json`、`pack-result-failure.json`、`asar-list-pnpm.txt`、`task-2-m1-insight-plan.log`）。

### 7.4 asarUnpack 通配在 pnpm 布局下的结论

| 通配行（M0 :46-52） | pnpm 布局下实测行为 |
|---|---|
| `node_modules/better-sqlite3/**` | 成立——.node 落 unpacked，`betterSqlite3NativeExists: true`（dlopen 的 asar 重映射 :56 机制不变） |
| `node_modules/sqlite-vec/**` | 语义弱化——pnpm 布局下该目录内不再有平台包（符号链接布局经 electron-builder 打包即提升），此行仅对本体 JS 生效（且实测本体 JS 留在 asar 内）；今后**不再承担解包 dll 的责任** |
| `node_modules/sqlite-vec-windows-x64/**` | **实际兜底行**——pnpm 布局下平台包已提升为 node_modules 顶层目录，此行命中并落 unpacked |

三条综合：**M0 的 asarUnpack 配置无需调整**；asPath 替换规则与包内 node_modules 布局无关，`replace('app.asar','app.asar.unpacked')` 照用（failure QA 证明该替换是唯一必要处理）。对 M1 的落地指引：`apps/desktop/electron-builder.yml` 现有 asarUnpack 只有 better-sqlite3 行（:1-9），todo 6（store v3 接 sqlite-vec）时须补 sqlite-vec 平台包行——Win 上关键行即 `**/node_modules/sqlite-vec-windows-x64/**`；若此后 macOS/Linux 产物一并出包，可用 `**/node_modules/sqlite-vec*/**` 一行覆盖全部平台包变体（届时按实打包物再验）。

### 7.5 风险注记勾销与遗留

- §3-③（:78-80）复跑义务：**已完成（本节）**。原注记担心的「pnpm 符号链接布局 + asar 打包行为不同」实测：electron-builder 25.1.8 把 pnpm 虚拟 store 依赖提升为 hoisted 顶层收进包内，路径假设由「嵌套」变「顶层」，通配行仍命中、asPath 规则不变。
- §6（:128）「workspace 内 M1 落地时需在 pnpm 布局下复跑本验证」：由本节关闭。
- 遗留：仅 **macOS「有条件则补」**沿用 M0 口径（:127，M5 notarize 前必须覆盖）。
- 复现工程：`bench/sqlite-vec-pnpm/{main.js,electron-builder.yml,package.json,pnpm-workspace.yaml,.npmrc,pnpm-lock.yaml,.gitignore}`（node_modules/release 已 gitignore；failure QA 为内置模式 `SQLITEVEC_BENCH_MODE=raw-path`，无需改代码）。
