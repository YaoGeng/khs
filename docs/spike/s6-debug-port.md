# Spike S6：CDP 调试口方案结论（pipe vs port=0+loopback+PID 校验）

> 映射 T-M0-05（todo 7）；证据脚本与原始输出：`bench/s6-debug/`（沙箱自带 package.json，不进 pnpm workspace）与本仓库 evidence 日志 `.omo/evidence/mvp0-dev-plan/task-7-mvp0-dev-plan.log`。
> 关联：04-架构评审报告.md S6（第 73-77 行）与放行条件（第 114 行）；02-系统架构设计.md §5.3（第 248-254 行）、§11.2（第 610-617 行）。

**测试机**：Windows 11 专业版，Intel i7-9750H @2.60GHz，31.9GB RAM，node v24.6.0
**被测内核**：Chrome 154.0.8037.98（`C:\Program Files\Google\Chrome\Application\chrome.exe`）、Edge 155.0.4283.45（x86 安装）、Electron 33.4.11（Chromium 130.0.6723.191，bench 沙箱内二进制）
**Playwright 引擎**：playwright-core 1.64.0（根 devDeps `@playwright/test@^1` 解析所得）

---

## 1. 结论（TL;DR）

**选型：路线 A——`--remote-debugging-pipe`。** Windows 上 Chromium 的 pipe 调试口**实测可用**（历史上"POSIX-only"的限制在 Chrome 154 / Edge 155 / Electron 33 上均不存在），且 pipe 模式**零 TCP 暴露面**（无监听端口、无 DevToolsActivePort 文件），从机制上消灭了 S6 指出的"本机恶意进程连入调试口"威胁，§5.3/§11.2 的"二期评估 pipe"可以提前到 V1 落地。

- 主集成形态：**Playwright（launchPersistentContext + executablePath=本机 Chrome/Edge）自托管 pipe**——todo 10 的 browser-service 直接使用，全程无 HTTP 端点，不存在外来连接问题。
- 零依赖备选：**自研 PipeTransport**（Node child_process `stdio:[ignore,pipe,pipe,pipe,pipe]`，fd 3 写命令 / fd 4 读响应，`\0` 分帧）——已裸写验证成功，不依赖 Playwright。
- D6 fallback 预置（若未来内核/打包形态不支持 pipe）：`--remote-debugging-port=0` + 仅 loopback（内核默认行为，实测仅绑 127.0.0.1）+ DevToolsActivePort 读端口 + CIM 进程树 PID 校验 + TCP 连接表外来连接检测。**port 模式对外来本机进程无接入层拒绝能力（实测），只能"发现+处置"**，边界见 §5。
- `connectOverCDP` 只认 http/ws endpoint，**对 pipe 模式启动的浏览器不适用**（无端点可连）；pipe 路线下不需要二次 attach（launcher 即 Playwright 实例，全 API 可用）。若走 port 路线则 connectOverCDP 可用（实测 OK）。

## 2. 路线 A 实测：--remote-debugging-pipe

### 2.1 配方来源（本地源码证据，非猜测）

playwright-core@1.64.0 bundle（`node_modules/.pnpm/playwright-core@1.64.0/node_modules/playwright-core/lib/coreBundle.js`）：

```js
// defaultArgs(): Chromium（含 branded Chrome）一律加 pipe 参数
chromeArguments.push(`--user-data-dir=${userDataDir}`);
chromeArguments.push("--remote-debugging-pipe");

// launchProcess(): stdio 五元组，fd3=写命令 fd4=读响应
const stdio = options.stdio === "pipe" ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
...
const stdio = launchedProcess.stdio;
transport = new PipeTransport2(stdio[3], stdio[4]);
```

### 2.2 裸 Node 复现（不经 Playwright，验证 Chromium 本身）——`bench/s6-debug/a1-pipe-raw.mjs`

关键实现：`spawn(exe, ['--remote-debugging-pipe', '--user-data-dir=<tmp>', 'about:blank'], { stdio: ['ignore','pipe','pipe','pipe','pipe'] })`，向 `child.stdio[3]` 写 `{"id":1,"method":"Browser.getVersion","params":{}}\0`，从 `child.stdio[4]` 读 `\0` 分帧响应。

```
$ node a1-pipe-raw.mjs --repeat 3 --headless                 （Chrome 154）
[A1] run1: OK attach=350ms product=Chrome/154.0.8037.98 protocol=1.3 exposure={"listeningSockets":[],"devToolsActivePortFile":null}
[A1] run2: OK attach=352ms ... exposure 同上
[A1] run3: OK attach=390ms ... exposure 同上
[A1] SUMMARY ok=3/3 attach_ms=[350,352,390] median=352

$ node a1-pipe-raw.mjs --repeat 3                            （Chrome 154，headful）
[A1] SUMMARY ok=3/3 attach_ms=[358,424,412] median=412

$ node a1-pipe-raw.mjs --repeat 3 --browser edge --headless  （Edge 155）
[A1] SUMMARY ok=3/3 attach_ms=[1009,545,548] median=548

$ node a1-pipe-raw.mjs --repeat 1 --browser electron --app <s6-electron-sticky> （Electron 33.4.11 / Chromium 130）
[A1] run1: OK attach=297ms product=Chrome/130.0.6723.191 exposure 同上
```

**要点**：
1. **Windows pipe 可用性疑问的实测回答：可用。** 三个内核全部一次握手成功，`Browser.getVersion` 正常返回 `protocol=1.3`。测试中遇到过的失败（fd4 提前关闭）是"app 秒退"竞态（todo-5 沙箱 app 写完结果即退出），换成常驻 app 后 Electron 也成功——不是 pipe 不可用。
2. **暴露面收敛实证**：每次运行都枚举浏览器进程树内所有 pid 的 netstat 行，`listeningSockets=[]`（零 TCP 监听）；profile 目录无 `DevToolsActivePort` 文件。pipe 模式下本机其他进程**没有任何端口可扫、没有文件可读**。
3. attach 时延与 port 路线同量级（见 §4 汇总）。

### 2.3 Playwright 托管 pipe（todo 10 主集成形态）——`bench/s6-debug/a2-pipe-playwright.mjs`

```js
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless, args: ['--no-first-run', '--no-default-browser-check', '--disable-sync'],
});
```

```
$ node a2-pipe-playwright.mjs --repeat 3 --headless
[A2] run1: OK ready=420ms eval=448ms evalResult=2 pipeArg=true portArg=false browserPid=12360 treeListeners=[] version=154.0.8037.98
[A2] run2: OK ready=436ms ... [A2] run3: OK ready=393ms ...
[A2] SUMMARY ok=3/3 ready_ms=[420,436,393] median=420

$ node a2-pipe-playwright.mjs --repeat 3    （headful，生产形态）
[A2] SUMMARY ok=3/3 ready_ms=[511,425,477] median=477
```

`pipeArg/portArg` 由 CIM 查询浏览器主进程 CommandLine 验证：**Playwright 对本机 branded Chrome 走的就是 `--remote-debugging-pipe`（且非 port）**，`treeListeners=[]` 零 TCP。playwright-core 官方 API（page/context/full CDP 会话）全程可用。

### 2.4 connectOverCDP 对 pipe 模式：不适用（如实记录）

`chromium.connectOverCDP(endpointURL)` 仅接受 http/ws 端点（playwright-core 源码 `_connectOverCDPInternal(progress2, endpointURL.toString(), ...)`；endpoint 来自 URL，无 pipe 变体）。pipe 启动的浏览器没有 http/ws 端点（§2.2 已证：无监听端口、无 DevToolsActivePort 文件），**没有 URL 可传——connectOverCDP 无法 attach pipe 模式浏览器**。
影响评估：**对本项目无影响**。todo 10 的浏览器是客户端自己拉起的（FR-3.1 一键拉起），launcher 自身就是 Playwright 实例、全 API 可用，不存在"另一个进程来 attach"的合法需求；"外来进程 attach"正是我们要防的威胁（pipe 下该威胁在机制上不存在）。

## 3. 路线 B 实测：port=0 + loopback + PID 校验（D6 fallback 预置）

### 3.1 主流程——`bench/s6-debug/b1-port-main.mjs`（Chrome 154，`--remote-debugging-port=0`）

启动后从 profile 下 `DevToolsActivePort` 文件读端口（250-385ms 内出现；stderr 同时会打印 `DevTools listening on ws://127.0.0.1:<port>/...`，两处可互为校验），随后 HTTP `/json/version` → ws `Browser.getVersion`。

```
$ node b1-port-main.mjs --repeat 3 --headless
[B1] run1: OK port=60167 file=282ms http=104ms attach=446ms pidValid=true boundOnlyLoopback=true listening=[{"localAddr":"127.0.0.1","port":60167,...,"state":"LISTENING","pid":26012}] lanProbe={"error":"ECONNREFUSED"} hostProbe={"status":500,"body":"Host header is specified and is not an IP address or local..."} originProbe={"rejected":true,"httpStatus":403}
[B1] run2: OK port=57781 file=250ms http=92ms  attach=384ms ... 同上全绿
[B1] run3: OK port=58955 file=262ms http=100ms attach=413ms ... 同上全绿
[B1] SUMMARY ok=3/3 attach_ms=[446,384,413] median=413 pidValidAll=true loopbackOnlyAll=true

$ node b1-port-main.mjs --repeat 3   （headful）
[B1] SUMMARY ok=3/3 attach_ms=[601,578,711] median=601 pidValidAll=true loopbackOnlyAll=true

$ node b1-port-main.mjs --repeat 2 --browser edge --headless
[B1] SUMMARY ok=2/2 attach_ms=[751,728] median=739 pidValidAll=true loopbackOnlyAll=true
```

### 3.2 逐项验证结论

| 验证项 | 命令/方法 | 实测结果 |
| --- | --- | --- |
| 端口随机化（port=0） | 读 `DevToolsActivePort` 文件首行 | 三次运行端口 60167/57781/58955，内核随机分配 ✓ |
| **仅绑 loopback** | `netstat -ano -p tcp` 过滤 LISTENING 行 | 每次仅一行 `127.0.0.1:<port> LISTENING`，**无 0.0.0.0** ✓（02 §5.3"端口随机化+仅本地回环"由内核默认行为满足） |
| **非 loopback 探测应拒绝** | 对本机 LAN IP 同端口发 HTTP | `ECONNREFUSED`（该接口无监听）✓ |
| Host 头跨域防护（DNS rebinding） | `Host: evil.example` 请求 /json/version | `HTTP 500 "Host header is specified and is not an IP address or localhost"` ✓（浏览器侧 CSRF 面收敛，仅防浏览器语境，不防本机进程） |
| ws 握手 Origin 校验 | 带 `Origin: http://evil.example` 发起 ws upgrade | `403`（Chrome 默认拒绝非空外来 Origin）✓ 同上边界：本机进程可省略 Origin 头绕过 |
| **来源 PID 校验**（04 S6 建议 b） | `Get-CimInstance Win32_Process` 沿 ParentProcessId 链向上回溯至 launcher pid；比对 netstat LISTENING 行 owning pid | `pidValid=true`（监听者在我们拉起的进程树内）✓，可防"连到假浏览器/串台浏览器" |
| attach 时延 | spawn→file→http→ws `Browser.getVersion` 响应 | headless 中位 413ms（ws 握手 24ms+响应 12ms 量级）；headful 中位 601ms |

**方法论留证**：首版脚本把 CIM 全进程查询放在了时延测量链中间，attach 一度测出 3392ms——系测量污染（CIM 查询 ~3s），ws 本体仅 34-47ms。修正后（先测时延后做安全探测）得 413ms。**给 todo 10 的教训：PID 校验不要进 CDP 可用性判定的热路径**（可作为周期性守卫任务或 attach 后校验）。

### 3.3 connectOverCDP 对 port 模式：可用——`bench/s6-debug/a3-connectovercdp.mjs`

```
$ node a3-connectovercdp.mjs --repeat 3 --headless
[A3] run1: OK port=63121 file=292ms connectOverCDP->ready=612ms pageEval=708ms eval=2 browserVersion=154.0.8037.98
[A3] run2: OK port=52494 ... 628ms   [A3] run3: OK port=55911 ... 700ms
[A3] SUMMARY ok=3/3 connectOverCDP_ms=[612,628,700] median=628
```

即：若走 port 路线，Playwright `connectOverCDP('http://127.0.0.1:<port>')` 亦是可用集成形态（但 browser-service 仍应自己拉起浏览器，不要 attach 用户已开的原生实例——那是用户登录态，属 FR-3.1 之外的行为）。

## 4. attach 时延汇总（≥3 次取中位，spawn→CDP 可用）

| 形态 | 浏览器 | 运行次数 | 样本 (ms) | **中位 (ms)** |
| --- | --- | --- | --- | --- |
| A 裸 pipe（headless） | Chrome 154 | 3 | 350/352/390 | **352** |
| A 裸 pipe（headful） | Chrome 154 | 3 | 358/424/412 | **412** |
| A 裸 pipe（headless） | Edge 155 | 3 | 1009/545/548 | **548** |
| A 裸 pipe | Electron 33.4.11（Chromium 130） | 1 | 297 | 297 |
| A Playwright pipe（headless） | Chrome 154 | 3 | 420/436/393 | **420** |
| A Playwright pipe（headful） | Chrome 154 | 3 | 511/425/477 | **477** |
| B port=0 自研 ws（headless） | Chrome 154 | 3 | 446/384/413 | **413** |
| B port=0 自研 ws（headful） | Chrome 154 | 3 | 601/578/711 | **601** |
| B port=0 connectOverCDP（headless） | Chrome 154 | 3 | 612/628/700 | **628** |
| B port=0 自研 ws（headless） | Edge 155 | 2 | 751/728 | **739** |

两路线时延同量级（0.3-0.7s），**时延不构成选型因素**；选 pipe 是安全面原因。

## 5. failure QA：外来进程连接调试口（port 模式暴露边界实证）——`bench/s6-debug/b4-failure-qa.mjs` + `b2-foreign.mjs`

模拟威胁 = 04 S6 原文"本机恶意进程可枚举（读 DevToolsActivePort 或端口扫描）后连入调试口操控已登录会话"。方法：launcher 拉起 port=0 浏览器并完成我方 ws 接管后，**另起一个完全独立的 node 进程**（不持任何文件/端点知识，仅知道端口），并跑 TCP 连接表检测器。

```
[B4] browser pid=8836 debug port=49419 (from DevToolsActivePort file)
[B4] [our client] ws Browser.getVersion -> OK Chrome/154.0.8037.98

[B2-FOREIGN] pid=17668 target=127.0.0.1:49419
[B2-FOREIGN] GET /json/version -> HTTP 200
[B2-FOREIGN] foreign sees Browser=Chrome/154.0.8037.98 webSocketDebuggerUrl=ws://127.0.0.1:49419/devtools/browser/da3f92d4-...
[B2-FOREIGN] GET /json/list -> HTTP 200 targets=5
[B2-FOREIGN] target-visible: type=page title="about:blank" url=about:blank
[B2-FOREIGN] TCP ESTABLISHED held (pid=17668) for 12000ms

[B4] detector: foreign client peer(s) detected: YES
[{"localAddr":"127.0.0.1","port":63462,"remote":"127.0.0.1:49419","state":"ESTABLISHED","pid":17668}, ...]
[B4] detector: foreign pid=17668 name=node.exe ppid=11472 inBrowserTree=false => ALERT/KILL candidate

[B4] [foreign ws client] Target.getTargets -> OK targets=6 (foreign ws attach ACCEPTED by Chrome)
[B4] [our client re-check] -> OK Chrome/154.0.8037.98   （我方连接不受影响，亦无任何"外来客户端"通知）
```

**结论边界（务必如实写进 todo 10 设计）**：
1. **port 模式无法对外来本机连接做接入层拒绝**——Chrome 的 DevTools HTTP/WS 服务端不受我们控制，不提供"校验对端 PID"的握手扩展；04 S6 建议 (a)"WebSocket 握手校验来源 PID"在 port 模式**不可实现**（实测：外来 ws attach 直接被接受，还与我方连接共存，Chrome 不做客户端隔离也不通知我方）。
2. **可实现的替代 = 检测+处置**：周期性（如 2s）查 `Get-NetTCPConnection`（或 `netstat -ano`），凡 established 对端 pid 不在浏览器进程树/我方 pid 集合 → 告警并可 `taskkill` 外来进程、必要时重启浏览器会话（§5.3 断连→suspended→重拉语义顺延）。**实测该检测器能稳定抓到外来 pid**（b4 输出 foreign pid=17668 被标记 ALERT/KILL candidate）。
3. 来源 PID 校验在 port 模式的**有效防区**是"确认我们拿到的端口属于我们自己拉起的浏览器"（防假浏览器/串台），不是防外来连接。
4. pipe 模式下上述整节威胁**在机制上不存在**（无端口可连、无文件可读），无需检测器——这是选 pipe 的核心理由。

## 6. 给 todo 10（browser-service）的配置项建议

**主路径（pipe，Playwright 托管）**——可直接复制的启动参数：

```js
// apps/desktop browser-service（M0：Chrome/Edge 探测次序见 FR-3.1；下载便携 Chromium 为降级分支）
import { chromium } from 'playwright-core';

const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath: userPreferredOrDetectedExe,      // 用户设置 > Chrome > Edge > (降级)随包 Chromium
  headless: false,                                  // M0 全链路 headful（FR-3 真实浏览器）
  args: [
    '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions',       // 减面；接管会话页所需的扩展按需放开
    // 不要传 --remote-debugging-port*：Playwright 自动用 --remote-debugging-pipe（实测验证 pipeArg=true）
  ],
});
```

- Profile 目录（FR-3.3 登录态持久化）：`%LOCALAPPDATA%/<app>/cdp-profiles/<platform>`，专用目录、不与用户日常 profile 共用；M0 单平台单 Profile（多账号 P2）。
- 校验步骤（一次性自检脚本可沿用本 spike a2 的断言）：
  1. 启动后 CIM 查浏览器主进程 CommandLine 含 `--remote-debugging-pipe` 且不含 `--remote-debugging-port`；
  2. `netstat` 确认浏览器进程树**零 LISTENING**、profile 目录**无 DevToolsActivePort 文件**——两条件即"pipe 生效"的机器可判据；
  3. `context.pages()` 可用即 CDP 通道就绪（不再需要端口发现）。
- 禁止任何人给该浏览器传 `--remote-debugging-port`（CI/排障例外：允许显式 opt-in 参数 + 文档标注仅限本机调试）。

**降级路径（port=0，仅当 pipe 不可用，如未来换内核/打包形态）**——配置项与校验步骤：

```js
const args = [
  '--remote-debugging-port=0',          // 内核随机选口
  `--user-data-dir=${profileDir}`,
  ...同上,
];
// 1) 读 profile/DevToolsActivePort 首行得 port（250-400ms 内出现；stderr "DevTools listening on ws://..." 可交叉校验）
// 2) PID 校验（防串台，不进热路径）：Get-CimInstance Win32_Process 沿 ParentProcessId 链确认
//    netstat LISTENING 行的 owning pid 在我们 spawn 的进程树内（本 spike lib/util.mjs isInProcessTree 可直接复用）
// 3) ws 接管 http://127.0.0.1:<port> 的 webSocketDebuggerUrl（实测中位 413ms 就绪）
// 4) 守卫任务（周期 2s）：Get-NetTCPConnection 查 established 对端，pid ∉ {浏览器树 ∪ 我方 pid} → 告警 + 处置（§5）
// 5) 仅 loopback 与 Host/Origin 校验由内核默认行为提供，无需额外配置（已实测）
```

- 同一 profile 目录 DACL 收紧为当前用户（默认即用户目录 ACL；不要放 %PROGRAMDATA% 等共享位置）。
- 时延预算参考：pipe headful 中位 477ms / port headful 中位 601ms，均远小于 FR/任务启动预算，不构成风险。

## 7. 注记与升级条款

- **渗透级验证留 M6**：本 spike 是 M0 结论级（机制验证+本地对抗模拟），不替代 04:114 放行条件中的"渗透测试"——渗透项（含会话操控尝试、内存/Cookie 边界、Profile ACL）归 M6"缓冲与合规审查"阶段执行。
- **选型为有利结论**（pipe 可用，优于预置 fallback），无需触发"不利结论当周升级架构师"条款（05 §7）。**仍需在评审材料包中标注**：若架构评审对 pipe 形态有异议（例如坚持自研 CDP 客户端而不引 Playwright、或目标内核验证失败），D6 fallback（port=0+loopback+PID 校验+TCP 检测）已实测可用，切换成本为 browser-service 一个启动参数 + 守卫任务；届时按 05 §7 流程当周升级架构师确认。
- Electron 33.4.11 裸二进制 pipe 可用（Chromium 130）：无 Chrome/Edge 的 CI 环境可用 Electron 常驻 app 做 CDP 对象；注意 Electron 秒退 app 会导致 fd4 提前关闭的误判。
- 本报告不改 01~09 基线；§5.3"二期评估 pipe"建议在 M0 门禁会上按本结论提前关闭（属结论汇报，非文档修订）。

## 8. 复现清单（bench/s6-debug/）

```bash
cd bench/s6-debug && npm install   # playwright-core@1.64.0 + ws（沙箱独立 package.json；npm 装，与 ELECTRON_MIRROR 无关）
node a1-pipe-raw.mjs --repeat 3 --headless          # 裸 pipe（Chrome；--browser edge|electron 可切换）
node a2-pipe-playwright.mjs --repeat 3 --headless   # Playwright 托管 pipe（含 CommandLine/零监听断言）
node b1-port-main.mjs --repeat 3 --headless         # port=0 全链路 + loopback/PID/Host/Origin 验证
node a3-connectovercdp.mjs --repeat 3 --headless    # connectOverCDP 对 port 模式
node b4-failure-qa.mjs --headless                   # failure QA：外来进程连接 + 检测器 + 多客户端共存
```
