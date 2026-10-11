import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CaptchaService } from './captcha.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, CaptchaService],
})
export class AuthModule {}
