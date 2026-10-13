/**
 * 遥测 ingest HTTP 边界（todo 9 = T-M1-07；02:734 POST /api/v1/telemetry/events）。
 * 匿名上报端点：不挂鉴权（匿名假名事件，无账号语义）；批量 + 服务端采样；consent ≠ true 422 拒收。
 */
import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parseTelemetryBatch } from './telemetry.dto.js';
import { TelemetryService } from './telemetry.service.js';

@Controller('telemetry')
export class TelemetryController {
  constructor(@Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  /** 请求体 = 事件数组（1..100）；202 = 已受理（含采样过滤），响应带实际入库数 */
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(@Body() body: unknown): Promise<{ accepted: number }> {
    const events = parseTelemetryBatch(body);
    return this.telemetry.ingest(events);
  }
}
