/**
 * 遥测模块（todo 9 = T-M1-07）：02 §12.1 遥测服务 M1 落地。
 * app.module 旧注记「遥测属 M1+ 不在此预建」自本模块起解禁（T-M1-07）。
 * 采样率常量与 clock 均为可覆盖 provider（e2e/单测注入固定随机序列与 fake clock）。
 */
import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller.js';
import { TELEMETRY_SAMPLING_RATE } from './telemetry.dto.js';
import {
  TelemetryService,
  TELEMETRY_CLOCK,
  TELEMETRY_SAMPLING,
} from './telemetry.service.js';

@Module({
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    { provide: TELEMETRY_SAMPLING, useValue: { rate: TELEMETRY_SAMPLING_RATE, random: () => Math.random() } },
    { provide: TELEMETRY_CLOCK, useValue: { now: () => new Date() } },
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {}
