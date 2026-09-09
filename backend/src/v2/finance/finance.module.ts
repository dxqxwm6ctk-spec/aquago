import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { PaymentAccountsService } from './payment-accounts.service';
import { RechargeService } from './recharge.service';
import { SubscriptionService } from './subscription.service';

@Module({
  providers: [LedgerService, RechargeService, PaymentAccountsService, SubscriptionService],
  exports: [LedgerService, RechargeService, PaymentAccountsService, SubscriptionService],
})
export class FinanceV2Module {}
