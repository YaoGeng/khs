import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/** HTTP 边界统一用 zod 解析请求体；解析失败返回 400 VALIDATION_ERROR。 */
export function parseJsonBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      error: 'VALIDATION_ERROR',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
