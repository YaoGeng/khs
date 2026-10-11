import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller.js';
import { DeviceService } from './device.service.js';
import { LicenseController } from './license.controller.js';
import { LicenseSigningService } from './license-signing.service.js';

/**
 * 授权模块（todo 8 = T-M0-07；02 §12.1 授权服务：许可证签发/设备绑定）。
 * LicenseSigningService 供 CardsModule（兑换后签发未绑定 license）复用。
 */
@Module({
  controllers: [LicenseController, DeviceController],
  providers: [LicenseSigningService, DeviceService],
  exports: [LicenseSigningService],
})
export class LicenseModule {}
