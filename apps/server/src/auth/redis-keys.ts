/** Redis 键的单一事实来源：业务层与测试共用，避免键名漂移。 */
export const captchaKey = (captchaId: string): string => `m0:captcha:${captchaId}`;
export const emailCodeKey = (email: string): string => `m0:emailcode:${email}`;
export const loginFailKey = (email: string): string => `m0:login:fail:${email}`;
export const loginLockKey = (email: string): string => `m0:login:lock:${email}`;
