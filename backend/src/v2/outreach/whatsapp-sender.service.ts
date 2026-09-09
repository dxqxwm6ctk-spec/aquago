import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { toJordanE164 } from '../common/phone.util';
import { CampaignsService } from './campaigns.service';
import {
  WHATSAPP_PROVIDER,
  type IWhatsAppProvider,
} from './whatsapp-provider';
import type { WhatsAppJob } from './whatsapp.queue';

/** البوابة نائمة — تُؤجَّل المهمة ولا تُحتسب محاولة فاشلة */
export class ProviderNotReadyError extends Error {
  constructor() {
    super('WHATSAPP_PROVIDER_NOT_READY');
  }
}

/** أخطاء لا تُصلحها إعادة المحاولة — إعادتها إزعاج لإنسان بلا فائدة */
const PERMANENT_SKIPS = new Set([
  'RECIPIENT_GONE',
  'CAMPAIGN_NOT_RUNNING',
  'ALREADY_PROCESSED',
  'LEAD_DELETED',
  'DO_NOT_CONTACT',
  'OPTED_OUT',
  'INVALID_NUMBER',
]);

@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);

  constructor(
    private prisma: PrismaV2Service,
    private campaigns: CampaignsService,
    @Inject(WHATSAPP_PROVIDER) private provider: IWhatsAppProvider,
  ) {}

  /**
   * معالجة مهمة إرسال واحدة.
   *
   * **كل الفحوصات تُعاد هنا وإن أجراها البدء.** بين لحظة الإدراج في الطابور
   * ولحظة الإرسال قد تمرّ ساعة: تُلغى الحملة، أو يطلب صاحب الرقم ألا
   * نراسله، أو يُحذف السجل. الطابور لا يعرف شيئاً من ذلك — القاعدة تعرف،
   * فتُسأل مرة أخرى قبل أن تخرج الرسالة.
   */
  async processSend(job: WhatsAppJob): Promise<void> {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: job.recipientId },
      include: { lead: { include: { whatsappContacts: true } }, campaign: true },
    });
    if (!recipient) {
      this.logger.warn(`مستلم غير موجود: ${job.recipientId}`);
      return;
    }

    // حارس الازدواج: أي حالة تتجاوز QUEUED تعني أن هذه المهمة تكرار —
    // إعادة تشغيل الخادم أو مهمة أُعيدت بعد نجاحها الصامت.
    if (!['PENDING', 'QUEUED'].includes(recipient.status)) {
      this.logger.debug(`تخطّي ${job.recipientId}: عولج مسبقاً (${recipient.status})`);
      return;
    }

    // **قائمة المنع العامة أولاً.** تُفحص هنا لا عند البدء وحده: بين الإدراج
    // في الطابور والإرسال قد يردّ صاحب الرقم «إلغاء» على رسالة أخرى، وحقّه
    // أن يسري انسحابه على ما لم يخرج بعد.
    const suppressed = await this.prisma.whatsAppOptOut.findUnique({
      where: { phoneNumber: recipient.phoneNumber },
    });
    if (suppressed) {
      await this.markSkipped(
        recipient.id,
        recipient.campaignId,
        'OPTED_OUT',
        'الرقم في قائمة المنع العامة',
      );
      await this.campaigns.completeIfDone(recipient.campaignId);
      return;
    }

    const skip = this.disqualify(recipient);
    if (skip) {
      await this.markSkipped(recipient.id, recipient.campaignId, skip.code, skip.reason);
      await this.campaigns.completeIfDone(recipient.campaignId);
      return;
    }

    // الحالة تُفحص الآن لا عند البدء: حملة أُوقفت أو أُلغيت بعد الإدراج
    if (recipient.campaign.status !== 'RUNNING') {
      // ليست تخطّياً نهائياً: الموقوفة تُستأنف لاحقاً وتُدرج من جديد
      await this.prisma.$transaction([
        this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: 'PENDING', queuedAt: null },
        }),
        // العدّاد يتبع الواقع: خرج الصف من الطابور فينقص، وإلا بقيت اللوحة
        // تعرض «في الطابور: ٣٠٠» لحملة موقوفة لا مهمة لها
        this.prisma.whatsAppCampaign.update({
          where: { id: recipient.campaignId },
          data: { queuedCount: { decrement: 1 } },
        }),
      ]);
      return;
    }

    // البوابة: لا نُرسل على العمياء ولا نعيد المحاولة فوراً — تُؤجَّل المهمة
    // ويتكفّل آلية إعادة اتصال البوابة القائمة بالتعافي.
    if (!(await this.provider.isReady())) {
      throw new ProviderNotReadyError();
    }

    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      }),
      this.prisma.whatsAppCampaign.update({
        where: { id: recipient.campaignId },
        data: { sendingCount: { increment: 1 }, queuedCount: { decrement: 1 } },
      }),
    ]);

    try {
      const { externalMessageId } =
        await this.provider.sendTemplateOrSupportedMessage(
          recipient.phoneNumber,
          job.body,
          job.template,
        );
      await this.recordSent(recipient, job, externalMessageId);
    } catch (e) {
      await this.recordFailure(recipient, job, e);
      throw e; // يعيد BullMQ المحاولة بتراجع أُسّي ضمن attempts
    } finally {
      await this.campaigns.completeIfDone(recipient.campaignId);
    }
  }

  /**
   * أسباب الاستبعاد النهائي — بترتيب أولويتها.
   *
   * `lead` قد يكون null: الحملات صارت تصل مستخدمي المنصة وقوائم أرقام لا
   * سجلَّ وكالة لها. وفحوص الوكالة تخصّها وحدها، أما قائمة المنع العامة
   * ورقمُ الهاتف فيُفحصان للجميع.
   */
  private disqualify(recipient: {
    lead: { deletedAt: Date | null; approvalStatus: string; doNotContact: boolean; whatsappOptInStatus: string; whatsappContacts: { phoneNumber: string; optInStatus: string }[] } | null;
    phoneNumber: string;
  }): { code: string; reason: string } | null {
    const lead = recipient.lead;
    if (!lead) {
      // مستخدم أو عضو قائمة: يبقى فحص الرقم، وقائمة المنع تُفحص قبل هذا
      return toJordanE164(recipient.phoneNumber)
        ? null
        : { code: 'INVALID_NUMBER', reason: 'ليس رقم محمول أردني صالح' };
    }
    if (lead.deletedAt || lead.approvalStatus === 'DELETED') {
      return { code: 'LEAD_DELETED', reason: 'السجل محذوف' };
    }
    if (lead.doNotContact) {
      return { code: 'DO_NOT_CONTACT', reason: 'السجل موسوم بعدم التواصل' };
    }
    if (lead.whatsappOptInStatus === 'OPTED_OUT') {
      return { code: 'OPTED_OUT', reason: 'انسحب من التواصل' };
    }
    // انسحاب على مستوى الرقم نفسه، ولو بقي السجل مفتوحاً
    const contact = lead.whatsappContacts.find(
      (c) => c.phoneNumber === recipient.phoneNumber,
    );
    if (contact?.optInStatus === 'OPTED_OUT') {
      return { code: 'OPTED_OUT', reason: 'هذا الرقم انسحب من التواصل' };
    }
    if (!toJordanE164(recipient.phoneNumber)) {
      return { code: 'INVALID_NUMBER', reason: 'ليس رقم محمول أردني صالح' };
    }
    return null;
  }

  private async markSkipped(
    recipientId: string,
    campaignId: string,
    code: string,
    reason: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: code === 'OPTED_OUT' ? 'OPTED_OUT' : 'SKIPPED',
          failureCode: code,
          failureReason: reason,
        },
      }),
      this.prisma.whatsAppCampaign.update({
        where: { id: campaignId },
        data: {
          // كل خروج من الطابور ينقصه، مهما كان سببه — وإلا انحرف العدّاد
          // عن الواقع بمقدار كل مستلم استُبعد عند لحظة الإرسال
          queuedCount: { decrement: 1 },
          ...(code === 'OPTED_OUT'
            ? { optedOutCount: { increment: 1 } }
            : { skippedCount: { increment: 1 } }),
        },
      }),
    ]);
  }

  private async recordSent(
    recipient: { id: string; campaignId: string; leadId: string | null; phoneNumber: string },
    job: WhatsAppJob,
    externalMessageId: string | null,
  ) {
    const now = new Date();
    const campaign = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: recipient.campaignId },
      select: { templateName: true, templateLanguage: true },
    });

    await this.prisma.$transaction(async (tx) => {
      const message = await tx.whatsAppMessage.create({
        data: {
          leadId: recipient.leadId,
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
          phoneNumber: recipient.phoneNumber,
          direction: 'OUTBOUND',
          messageType: 'TEXT',
          templateName: campaign?.templateName ?? null,
          templateLanguage: campaign?.templateLanguage ?? null,
          body: job.body,
          externalMessageId,
          status: 'SENT',
          sentAt: now,
        },
      });
      await tx.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: 'SENT', sentAt: now, messageId: message.id },
      });
      await tx.whatsAppCampaign.update({
        where: { id: recipient.campaignId },
        data: { sentCount: { increment: 1 }, sendingCount: { decrement: 1 } },
      });
      // سجلّ التواصل وحقول آخر اتصال تخصّ الوكالات المحتملة وحدها. مستخدمُ
      // المنصة له إشعاراته وتفضيلاته، وعضو القائمة رقمٌ بلا سجل — ولا معنى
      // لاختراع صفٍّ في `AgencyOutreach` لأيٍّ منهما.
      if (!recipient.leadId) return;
      await tx.agencyOutreach.create({
        data: {
          leadId: recipient.leadId,
          channel: 'WHATSAPP',
          contactType: 'INITIAL_OUTREACH',
          phoneNumber: recipient.phoneNumber,
          campaignId: recipient.campaignId,
          messageId: message.id,
          status: 'SENT',
          contactedAt: now,
        },
      });
      const lead = await tx.agencyLead.findUnique({
        where: { id: recipient.leadId },
        select: { firstContactAt: true },
      });
      await tx.agencyLead.update({
        where: { id: recipient.leadId },
        data: {
          contactStatus: 'CONTACTED',
          firstContactAt: lead?.firstContactAt ?? now,
          lastContactAt: now,
        },
      });
    });
  }

  private async recordFailure(
    recipient: { id: string; campaignId: string; leadId: string | null; phoneNumber: string; attempts: number },
    job: WhatsAppJob,
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date();
    // آخر محاولة فقط تُعلن الفشل نهائياً — ما قبلها تعود إلى الطابور
    const isFinal = recipient.attempts >= 3;
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: isFinal
          ? {
              status: 'FAILED',
              failedAt: now,
              failureCode: 'SEND_FAILED',
              failureReason: message,
            }
          : { status: 'QUEUED', failureReason: message },
      }),
      this.prisma.whatsAppCampaign.update({
        where: { id: recipient.campaignId },
        data: isFinal
          ? { failedCount: { increment: 1 }, sendingCount: { decrement: 1 } }
          : { queuedCount: { increment: 1 }, sendingCount: { decrement: 1 } },
      }),
    ]);
    if (isFinal) {
      await this.guardAgainstTotalFailure(recipient.campaignId);
      await this.prisma.whatsAppMessage.create({
        data: {
          leadId: recipient.leadId,
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
          phoneNumber: recipient.phoneNumber,
          direction: 'OUTBOUND',
          messageType: 'TEXT',
          body: job.body,
          status: 'FAILED',
          errorCode: 'SEND_FAILED',
          errorMessage: message,
          failedAt: now,
        },
      });
      if (recipient.leadId) {
        await this.prisma.agencyLead.update({
          where: { id: recipient.leadId },
          data: { contactStatus: 'CONTACT_FAILED' },
        });
      }
    }
    this.logger.warn(
      `فشل الإرسال إلى ${recipient.phoneNumber} (محاولة ${recipient.attempts}): ${message}`,
    );
  }

  /**
   * يوقف الحملة إذا لم تنجح منها رسالة واحدة بعد عدة إخفاقات نهائية.
   *
   * سببها حالة وقعت فعلاً: بوابة واتساب متصلة وسليمة، لكن الرقم مقيَّد من
   * واتساب نفسه بمنع بدء محادثات جديدة. الجلسة تقول «متصل»، وكل إرسال
   * يُقبل ثم لا يصل، فتمضي الحملة على مئات المستلمين تحرقهم واحداً واحداً:
   * كلٌّ منهم يصير «سبق التواصل معه» فلا تعود إليه حملة بعد إصلاح السبب،
   * ومئات المحاولات المرفوضة على رقم مقيَّد تدفع التقييد إلى حظر كامل.
   *
   * الشرط ضيّق عمداً — **صفر نجاح** مع خمسة إخفاقات: فشلٌ متفرّق بين نجاحات
   * أمرٌ طبيعي (رقم مغلق، رقم بلا واتساب) ولا يستدعي إيقاف حملة تعمل.
   */
  private async guardAgainstTotalFailure(campaignId: string) {
    const campaign = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, sentCount: true, failedCount: true, name: true },
    });
    if (!campaign || campaign.status !== 'RUNNING') return;
    // العدّاد الحالي لا يشمل هذا الإخفاق بعد — فالعتبة أربعة سابقة وهذا الخامس
    if (campaign.sentCount > 0 || campaign.failedCount < 4) return;

    await this.prisma.whatsAppCampaign.update({
      where: { id: campaignId },
      data: { status: 'PAUSED' },
    });
    this.logger.error(
      `أُوقفت الحملة «${campaign.name}» تلقائياً: ${campaign.failedCount + 1} إخفاقاً بلا نجاح واحد. ` +
        'راجع حالة رقم البوابة لدى واتساب — قد يكون مقيَّداً عن بدء محادثات جديدة.',
    );
    await this.prisma.auditLog.create({
      data: {
        // النظام هو الفاعل هنا لا إنسان — نتركه بلا فاعل بشري متعمَّد
        actorUserId: (
          await this.prisma.userRole.findFirst({
            where: { role: { name: 'SUPER_ADMIN' } },
            select: { userId: true },
          })
        )?.userId ?? '',
        action: 'campaign.auto-paused',
        entityType: 'WhatsAppCampaign',
        entityId: campaignId,
        newValue: {
          reason: 'إخفاق كامل — لا رسالة نجحت',
          failed: campaign.failedCount + 1,
        },
      },
    }).catch(() => undefined);
  }

  static isPermanent(code: string): boolean {
    return PERMANENT_SKIPS.has(code);
  }
}
