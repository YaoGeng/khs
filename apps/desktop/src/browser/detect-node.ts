/**
 * 浏览器探测的 node 侧绑定（todo 10 = T-M0-08）：注册表读取走 reg.exe，
 * 与纯探测逻辑（detect.ts）分离——后者用注入 deps 单测，本文件不做逻辑。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/**
 * 读 App Paths 默认值（HKLM/HKCU；`reg query <key> /ve`）。
 * 输出形如 `    (默认)    REG_SZ    C:\Program Files\...\chrome.exe`；键不存在 → 非零退出 → null。
 */
export async function registryQueryAppPaths(keyPath: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('reg', ['query', keyPath, '/ve'], { windowsHide: true });
    const match = stdout.match(/REG_SZ\s+(.+?)\s*$/im);
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
