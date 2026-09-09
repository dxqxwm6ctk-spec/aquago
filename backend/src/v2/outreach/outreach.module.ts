import { Module } from '@nestjs/common';
import { AuthV2Module } from '../auth/auth-v2.module';
import { AgencyApplyController } from './agency-apply.controller';
import { AgencyLeadsController } from './agency-leads.controller';
import { AgencyLeadsService } from './agency-leads.service';
import {
  CampaignsController,
  WhatsAppEventsController,
  WhatsAppGatewayController,
} from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { LeadImportService } from './lead-import.service';
import {
  RecipientListsController,
  RecipientListsService,
} from './recipient-lists.controller';
import { MetaCloudProvider } from './meta-cloud.provider';
import { MetaCloudModule } from './meta-cloud.module';
import { MetaWebhookController } from './meta-webhook.controller';
import { OpenWaProvider, WHATSAPP_PROVIDER } from './whatsapp-provider';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import { WhatsAppEventsService } from './whatsapp-events.service';
import { WhatsAppQueue } from './whatsapp.queue';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { WhatsAppWorker } from './whatsapp.worker';

/**
 * وحدة الوكالات المحتملة والتواصل معها.
 *
 * **ما لا تُنشئه هذه الوحدة عمداً:**
 *  - لا اتصال Redis جديد: `bullConnection()` مستوردة من طابور المحرك.
 *  - لا مكتبة واتساب ولا جلسة ثانية: `AuthV2Module` تصدّر `WhatsappService`
 *    القائمة، و`OpenWaProvider` غلافٌ حولها لا بديل عنها.
 *  - لا نظام webhook منافس: مستقبِل الأحداث يتبع نمط webhook تيليجرام نفسه.
 */
@Module({
  imports: [AuthV2Module, MetaCloudModule],
  controllers: [
    AgencyLeadsController,
    AgencyApplyController,
    CampaignsController,
    WhatsAppGatewayController,
    WhatsAppEventsController,
    MetaWebhookController,
    RecipientListsController,
  ],
  providers: [
    AgencyLeadsService,
    LeadImportService,
    CampaignsService,
    WhatsAppQueue,
    WhatsAppSenderService,
    WhatsAppWorker,
    WhatsAppEventsService,
    WhatsAppAdminService,
    RecipientListsService,
    OpenWaProvider,
    {
      // قناة الحملات وحدها تُختار هنا. رموز التحقق تمرّ بـWhatsappService
      // مباشرة ولا تمسّها هذه الراية — نقلُها قرار منفصل بمخاطرة أكبر:
      // فشلُ قناة الحملات يؤجّل تسويقاً، وفشلُ قناة الرموز يقفل باب الدخول.
      provide: WHATSAPP_PROVIDER,
      useFactory: (openwa: OpenWaProvider, meta: MetaCloudProvider) =>
        process.env.WHATSAPP_CAMPAIGN_PROVIDER === 'meta' ? meta : openwa,
      inject: [OpenWaProvider, MetaCloudProvider],
    },
  ],
  exports: [AgencyLeadsService, CampaignsService],
})
export class OutreachV2Module {}
