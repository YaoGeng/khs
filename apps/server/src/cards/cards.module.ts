import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';
import { LicenseModule } from '../license/license.module.js';

@Module({
  imports: [LicenseModule],
  controllers: [CardsController],
  providers: [CardsService],
})
export class CardsModule {}
