import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parseJsonBody } from '../common/http.js';
import { DeviceService, type ActivationResult } from './device.service.js';
import { activateRequestSchema } from './license.dto.js';

/**
 * 02 §9.5 许可证时序 / §12.1 授权服务（/api/v1/license/*）：
 * POST /license/activate —— 出示兑换签发的 license + 本机设备指纹哈希，完成设备绑定并换发绑定版 license。
 * M0 无会话：以 {email, licenseJwt} 定位（与 D9 兑换的「email 即凭据」同姿态）；会话化归 T-M5-02。
 */
@Controller('license')
export class LicenseController {
  constructor(@Inject(DeviceService) private readonly devices: DeviceService) {}

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() body: unknown): Promise<ActivationResult> {
    const dto = parseJsonBody(activateRequestSchema, body);
    return this.devices.activate(dto.email, dto.licenseJwt, dto.device_hash);
  }
}
