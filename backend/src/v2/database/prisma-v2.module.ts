import { Global, Module } from '@nestjs/common';
import { PrismaV2Service } from './prisma-v2.service';

@Global()
@Module({
  providers: [PrismaV2Service],
  exports: [PrismaV2Service],
})
export class PrismaV2Module {}
