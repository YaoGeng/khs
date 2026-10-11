import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';

@Module({
  controllers: [CardsController],
  providers: [CardsService],
})
export class CardsModule {}
