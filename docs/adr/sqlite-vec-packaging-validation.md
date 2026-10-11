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
