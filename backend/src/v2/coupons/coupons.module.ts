import { Module } from '@nestjs/common';
import { CouponsService } from './coupons.service';

@Module({
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsV2Module {}
