import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

// 02 §11.3：BCrypt cost 12（F2/Q2 对齐；bcryptjs 纯 JS 实现，M0 性能可接受）
const BCRYPT_COST = 12 as const;

/** FR-1.1：密码 BCrypt 哈希入库；bcryptjs 为纯 JS 实现（02 §3.1 选型允许，见 docs/adr/notes-dev-transports.md）。 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    return hash(password, BCRYPT_COST);
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }
}
