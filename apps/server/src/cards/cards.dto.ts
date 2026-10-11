import { z } from 'zod';

// D9 最小兑换：code 明文 + email 绑定（05:72 门禁①顺序：注册→兑换→登录；会话内兑换归 T-M5-02）
export const redeemRequestSchema = z.object({
  code: z.string().trim().min(12).max(80).transform((code) => code.toUpperCase()),
  email: z.email(),
});

export type RedeemRequest = z.infer<typeof redeemRequestSchema>;
