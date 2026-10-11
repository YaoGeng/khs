/**
 * license 链路的 main 进程绑定（todo 8）：把 license-manager 纯逻辑接到 userData 目录与本机指纹。
 * 本文件不 import electron（userDataDir 由 main.ts 以 app.getPath('userData') 注入），vitest 可单测。
 *
 * M0 激活语义（任务卡）：客户端走「本地注入 license + 公钥离线验签」路径——
 * 不发起任何网络请求；真机联网激活流（02 §9.5 全时序）归 M5。
 */
import path from 'node:path';
import process from 'node:process';
import { localDeviceHash } from '../license/device-fingerprint';
import {
  computeLicenseStatus,
  loadEnvelope,
  saveEnvelope,
  verifyLicenseJwt,
  type LicenseEnvelope,
  type LicenseStatus,
} from '../license/license-manager';
import { LICENSE_PUBLIC_KEY_PEM } from '../license/public-key';
import type { LicenseIpcDeps } from './ipc-core';

export function createLicenseService(userDataDir: string): LicenseIpcDeps {
  // dev/test seam：e2e 经 XINGLIAN_LICENSE_FILE 注入 license 文件位置；生产固定 userData/license.json
  const licenseFile =
    process.env.XINGLIAN_LICENSE_FILE ?? path.join(userDataDir, 'license.json');
  const deviceHash = localDeviceHash();

  const status = (): LicenseStatus =>
    computeLicenseStatus({
      envelope: loadEnvelope(licenseFile),
      publicKeyPem: LICENSE_PUBLIC_KEY_PEM,
      now: new Date(),
      localDeviceHash: deviceHash,
    });

  return {
    activate(params) {
      const verified = verifyLicenseJwt(params.licenseJwt, LICENSE_PUBLIC_KEY_PEM, new Date());
      if (!verified.ok) {
        // 验签失败不写 envelope（防篡改/过期 license 覆盖有效态）；状态机按失败原因锁定
        return { state: 'locked', reason: verified.reason, deviceHash };
      }
      // 绑定语义：license 已绑定到其他设备 → 拒绝激活（device_hash='' 未绑定态可激活）
      if (verified.claims.device_hash.length > 0 && verified.claims.device_hash !== deviceHash) {
        return { state: 'locked', reason: 'DEVICE_MISMATCH', deviceHash, licenseDeviceHash: verified.claims.device_hash };
      }
      const envelope: LicenseEnvelope = {
        licenseJwt: params.licenseJwt,
        lastVerifiedAt: new Date().toISOString(),
        deviceHash,
      };
      saveEnvelope(licenseFile, envelope);
      return status();
    },
    status,
  };
}
