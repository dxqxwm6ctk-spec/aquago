import { Module } from '@nestjs/common';
import { ContractsV2Module } from '../contracts/contracts.module';
import { FinanceV2Module } from '../finance/finance.module';
import { SchedulerQueue } from './scheduler.queue';
import { SchedulerWorker } from './scheduler.worker';

/**
 * المهام الدورية — بديل مؤقّتات `setInterval` التي كانت داخل الخدمات.
 *
 * الوحدة تُحمَّل في الدورين معاً، لكن `SchedulerQueue` تسجّل التكرار و
 * `SchedulerWorker` ينشئ المستهلك على `ROLE=worker` وحده. الفصل داخل
 * الصنفين لا في الوحدة عمداً: وحدةٌ تُحمَّل شرطياً تُخفي أخطاء الحقن حتى
 * لحظة النشر، بينما الحارس داخل `onModuleInit` يُبقي رسم الاعتماديات واحداً
 * في الدورين — فما يُصرَّف في CI هو ما يعمل في الإنتاج.
 */
@Module({
  imports: [ContractsV2Module, FinanceV2Module],
  providers: [SchedulerQueue, SchedulerWorker],
})
export class SchedulerV2Module {}
