import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { parseJsonBody } from '../common/http.js';
import { DeviceService, type UnbindResult } from './device.service.js';
import { unbindRequestSchema } from './license.dto.js';

/**
 * FR-1.4 设备管理（M0 最小闭环）：POST /devices/unbind —— 自助解绑，30 天限 1 次。
 * 设备列表展示/远程解绑审批等 B 端页面归 M5（Must NOT do：不做 B 端设备管理页）。
 */
@Controller('devices')
export class DeviceController {
  constructor(@Inject(DeviceService) private readonly devices: DeviceService) {}

  @Post('unbind')
  @HttpCode(HttpStatus.OK)
  async unbind(@Body() body: unknown): Promise<UnbindResult> {
    const dto = parseJsonBody(unbindRequestSchema, body);
    return this.devices.unbind(dto.email, dto.device_hash);
  }
}
