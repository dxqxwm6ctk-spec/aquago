import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma-v2/client';
import { computePoolPlan, describePoolPlan, withPoolParams } from './connection-pool';

/**
 * اتصال مخطط المنصة الجديد (jordan_gas_v2) — منفصل تماماً عن PrismaService
 * القديم حتى لا تختلط الاتصالات أثناء الترحيل (خطة المرحلة 2.1).
 *
 * `connection_limit` صريح على الرابط — انظر connection-pool.ts. هذا العميل
 * هو الثاني من عميلَي كل عملية، فحصته من تجمّع الاتصالات محسوبة معاً مع
 * PrismaService لا بمعزل عنه.
 */
@Injectable()
export class PrismaV2Service
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly logger = new Logger(PrismaV2Service.name);

  constructor() {
    const plan = computePoolPlan();
    const base = process.env.DATABASE_URL_V2;
    if (!base) {
      throw new Error('DATABASE_URL_V2 غير معرَّف — لا يمكن إنشاء PrismaV2Service');
    }
    super({
      datasources: {
        db: { url: withPoolParams(base, plan.connectionLimitPerClient) },
      },
    });
    PrismaV2Service.logger.log(`v2 — ${describePoolPlan(plan)}`);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
