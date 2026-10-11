import { Global, Module } from '@nestjs/common';
import { MembershipService } from './membership.service.js';

@Global()
@Module({
  providers: [MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
