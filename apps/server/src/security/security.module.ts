import { Global, Module } from '@nestjs/common';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Global()
@Module({
  providers: [TokenService, PasswordService],
  exports: [TokenService, PasswordService],
})
export class SecurityModule {}
