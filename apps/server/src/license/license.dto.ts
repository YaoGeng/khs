/** todo 8（T-M0-07）：license 激活/解绑入参。device_hash 为 sha256 hex 64 位（02 §11.4：仅哈希上行）。 */
import { z } from 'zod';

export const deviceHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'device_hash 必须是 sha256 hex(64)');

export const activateRequestSchema = z.object({
  email: z.email(),
  // min(1)：损坏/混淆 token（短串、缺段）也要放行到验签层，以稳定错误码 401 拒绝，而非 400
  licenseJwt: z.string().min(1).max(8000),
  device_hash: deviceHashSchema,
});

export const unbindRequestSchema = z.object({
  email: z.email(),
  device_hash: deviceHashSchema,
});

export type ActivateRequest = z.infer<typeof activateRequestSchema>;
export type UnbindRequest = z.infer<typeof unbindRequestSchema>;
