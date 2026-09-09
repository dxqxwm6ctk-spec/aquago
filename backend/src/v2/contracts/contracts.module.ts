import { Module } from '@nestjs/common';
import { NotificationsV2Module } from '../notifications/notifications.module';
import {
  AgencyContractsController,
  PlatformContractsController,
  PublicContractsController,
} from './contracts.controller';
import { ContractAlertsService } from './contract-alerts.service';
import { ContractsService } from './contracts.service';

@Module({
  imports: [NotificationsV2Module],
  controllers: [
    AgencyContractsController,
    PlatformContractsController,
    PublicContractsController,
  ],
  providers: [ContractsService, ContractAlertsService],
  exports: [ContractsService, ContractAlertsService],
})
export class ContractsV2Module {}
