import { Module } from '@nestjs/common';
import {
  AgencyCtaAdminController,
  AgencyCtaController,
  AgencyCtaService,
} from './agency-cta.controller';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';

@Module({
  controllers: [AppVersionController, AgencyCtaController, AgencyCtaAdminController],
  providers: [AppVersionService, AgencyCtaService],
})
export class AppVersionV2Module {}
