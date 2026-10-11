import { z } from 'zod';

// FR-1.1：邮箱 + 验证码注册；密码强度校验（≥8 位且含字母与数字）
export const emailCodeRequestSchema = z.object({ email: z.email() });

export const registerRequestSchema = z.object({
  email: z.email(),
  password: z
    .string()
    .min(8)
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/[0-9]/, 'must contain a digit'),
  code: z.string().regex(/^\d{6}$/, 'must be a 6-digit email code'),
});

// FR-1.2：账号密码 + 图形验证码
export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  captchaId: z.string().min(16),
  captchaAnswer: z.string().min(1).max(4),
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(16) });

export type EmailCodeRequest = z.infer<typeof emailCodeRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
