import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parseJsonBody } from '../common/http.js';
import { CardsService, type RedeemResult } from './cards.service.js';
import { redeemRequestSchema } from './cards.dto.js';

/**
 * 02 §13 /api/v1/*：D9 最小兑换。
 * M0 以 {code, email} 绑定（无会话）——激活码本身即凭据；会话内兑换/防爆破全量归 T-M5-02。
 */
@Controller('cards')
export class CardsController {
  constructor(@Inject(CardsService) private readonly cards: CardsService) {}

  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  async redeem(@Body() body: unknown): Promise<RedeemResult> {
    const dto = parseJsonBody(redeemRequestSchema, body);
    return this.cards.redeem(dto.email, dto.code);
  }
}
