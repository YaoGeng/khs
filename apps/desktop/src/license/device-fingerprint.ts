/**
 * 设备指纹采集（main 进程；02-系统架构设计.md §11.4「设备指纹仅存哈希」）。
 * M0 算法（任务卡指定）：hostname + CPU 型号 + MAC 规范化拼接 sha256。
 * M5 强化方向：主板/磁盘序列号 + 随机安装 ID（02 §12.3 目标口径）。
 */
import { cpus, networkInterfaces, hostname } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { fingerprintHash } from './license-manager';

/** 取首个非内部、带 MAC 的网卡的 MAC（按接口名排序保证顺序稳定；无则占位串参与哈希） */
export function primaryMac(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') return info.mac;
    }
  }
  return 'no-mac';
}

export function localDeviceHash(): string {
  return fingerprintHash({
    hostname: hostname(),
    cpuModel: cpus()[0]?.model ?? 'unknown-cpu',
    mac: primaryMac(),
  });
}
