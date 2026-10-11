import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/prisma.service.js';

/**
 * 审计骨架（02 §14.2 audit_logs）。M0 记录：user.register / card.redeem。
 * 可传入事务客户端，让审计与业务写同事务落库。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async write(
    client: Prisma.TransactionClient,
    actor: string,
    action: string,
    payload: Readonly<Record<string, Prisma.InputJsonValue>>,
  ): Promise<void> {
    await client.auditLog.create({ data: { actor, action, payloadJson: { ...payload } } });
  }
}
