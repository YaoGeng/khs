import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parseJsonBody } from '../common/http.js';
import {
  emailCodeRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
} from './auth.dto.js';
import { AuthService, type LoginResult, type RefreshResult, type RegisterResult } from './auth.service.js';
import { CaptchaService, type CaptchaChallenge } from './captcha.service.js';

/** 02 §13 /api/v1/auth/*：邮箱验证码、注册、图形验证码、登录、刷新。 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
  ) {}

  /** 动作型端点（非资源创建）统一 200；register 保留 201 Created。 */
  @Post('email-code')
  @HttpCode(HttpStatus.OK)
  async emailCode(@Body() body: unknown): Promise<Readonly<{ code: string }>> {
    const dto = parseJsonBody(emailCodeRequestSchema, body);
    return this.auth.sendEmailCode(dto.email);
  }

  @Post('register')
  async register(@Body() body: unknown): Promise<RegisterResult> {
    return this.auth.register(parseJsonBody(registerRequestSchema, body));
  }

  @Post('captcha')
  @HttpCode(HttpStatus.OK)
  async createCaptcha(): Promise<CaptchaChallenge> {
    return this.captcha.create();
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown): Promise<LoginResult> {
    return this.auth.login(parseJsonBody(loginRequestSchema, body));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: unknown): Promise<RefreshResult> {
    const dto = parseJsonBody(refreshRequestSchema, body);
    return this.auth.refresh(dto.refreshToken);
  }
}
