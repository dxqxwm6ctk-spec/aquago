import { Injectable, Logger } from '@nestjs/common';
import type { WaMessageStatus } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { AgencyLeadsService } from './agency-leads.service';
import { CampaignsService } from './campaigns.service';
import { AuthV2Service } from '../auth/auth-v2.service';
import { normalizePhoneForMatch } from './duplicate-detection.util';

/**
 * ترتيب دورة حياة الرسالة. المعالجة **لا تتراجع أبداً**: حدث DELIVERED يصل
 * بعد READ (الشبكات لا تحترم الترتيب) لا يجوز أن يعيد الرسالة خطوة ولا أن
 * ينقص عدّاداً. الأعلى وحده يتقدّم.
 */
const RANK: Record<string, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

/** كلمات الانسحاب — تُحترم فوراً بلا مرور على أدمن */
const OPT_OUT_WORDS = [
  'stop',
  'unsubscribe',
  'الغاء',
  'إلغاء',
  'الغ',
  'ايقاف',
  'إيقاف',
  'لا ترسل',
  'لا تراسلني',
  'مو مهتم',
  'غير مهتم',
];

const INTEREST_WORDS = ['نعم', 'موافق', 'مهتم', 'اهلا', 'أهلاً', 'yes', 'ok', 'تمام'];

@Injectable()
export class WhatsAppEventsService {
  private readonly logger = new Logger(WhatsAppEventsService.name);

  constructor(
    private prisma: PrismaV2Service,
    private leads: AgencyLeadsService,
    private campaigns: CampaignsService,
    private auth: AuthV2Service,
  ) {}

  /**
   * حدث حالة من البوابة (SENT / DELIVERED / READ / FAILED).
   *
   * **الطبيعة الـidempotent هنا بنيوية لا احتياطية:**
   *  - الربط عبر `externalMessageId` وهو فريد في القاعدة.
   *  - الانتقال يُقارَن بالرتبة، فالحدث المكرر لا يتجاوز الشرط أصلاً.
   *  - عدّاد الحملة يُزاد **داخل نفس المعاملة** التي تغيّر حالة الرسالة، فلا
   *    يوجد مسار يزيد العدّاد مرتين لحدث واحد.
   */
  async handleStatusEvent(evt: {
    externalMessageId: string;
    status: string;
    timestamp?: string;
    errorCode?: string;
    errorMessage?: string;
  }) {
    const status = this.normalizeStatus(evt.status);
    if (!status) {
      this.logger.debug(`حدث بحالة غير معروفة: ${evt.status}`);
      return { ok: true, applied: false };
    }

    const message = await this.prisma.whatsAppMessage.findUnique({
      where: { externalMessageId: evt.externalMessageId },
    });
    if (!message) {
      // رسالة لا نعرفها — رمز تحقق مثلاً، أو رسالة أرسلها إنسان من الهاتف
      return { ok: true, applied: false };
    }

    if (status !== 'FAILED' && RANK[status] <= RANK[message.status]) {
      return { ok: true, applied: false }; // حدث مكرر أو متأخر
    }

    const at = evt.timestamp ? new Date(evt.timestamp) : new Date();
    const applied = await this.prisma.$transaction(async (tx) => {
      // إعادة القراءة داخل المعاملة: حدثان متزامنان لنفس الرسالة لا يمرّان معاً
      const fresh = await tx.whatsAppMessage.findUnique({
        where: { id: message.id },
      });
      if (!fresh) return false;
      if (status !== 'FAILED' && RANK[status] <= RANK[fresh.status]) return false;
      if (status === 'FAILED' && fresh.status === 'FAILED') return false;

      await tx.whatsAppMessage.update({
        where: { id: message.id },
        data: {
          status,
          deliveredAt: status === 'DELIVERED' ? at : undefined,
          readAt: status === 'READ' ? at : undefined,
          failedAt: status === 'FAILED' ? at : undefined,
          errorCode: evt.errorCode ?? undefined,
          errorMessage: evt.errorMessage ?? undefined,
        },
      });

      if (message.recipientId) {
        await tx.campaignRecipient.update({
          where: { id: message.recipientId },
          data: {
            status: status === 'FAILED' ? 'FAILED' : (status as never),
            deliveredAt: status === 'DELIVERED' ? at : undefined,
            readAt: status === 'READ' ? at : undefined,
            failedAt: status === 'FAILED' ? at : undefined,
            failureCode: status === 'FAILED' ? (evt.errorCode ?? 'PROVIDER_FAILED') : undefined,
            failureReason: status === 'FAILED' ? (evt.errorMessage ?? null) : undefined,
          },
        });
      }

      if (message.campaignId) {
        const field = {
          DELIVERED: 'deliveredCount',
          READ: 'readCount',
          FAILED: 'failedCount',
          SENT: 'sentCount',
        }[status];
        if (field) {
          await tx.whatsAppCampaign.update({
            where: { id: message.campaignId },
            data: { [field]: { increment: 1 } },
          });
        }
      }
      return true;
    });

    if (applied && message.campaignId) {
      await this.campaigns.completeIfDone(message.campaignId);
    }
    return { ok: true, applied };
  }

  private normalizeStatus(raw: string): WaMessageStatus | null {
    const s = raw.trim().toUpperCase();
    if (['SENT', 'SERVER_ACK'].includes(s)) return 'SENT';
    if (['DELIVERED', 'DELIVERY_ACK'].includes(s)) return 'DELIVERED';
    if (['READ', 'READ_ACK'].includes(s)) return 'READ';
    if (['FAILED', 'ERROR'].includes(s)) return 'FAILED';
    return null;
  }

  /**
   * رسالة واردة.
   *
   * ثلاثة آثار بترتيب الأهمية: تسجيلها، ثم احترام الانسحاب إن كانت انسحاباً،
   * ثم تحديث حالة الردّ. الانسحاب **قبل** كل شيء آخر: لا ينتظر مراجعة أدمن،
   * لأن كل تأخير فيه يعني رسالة أخرى إلى من طلب ألا تصله.
   */
  async handleInboundMessage(evt: {
    from: string;
    body?: string;
    externalMessageId?: string;
    timestamp?: string;
  }) {
    const phone = normalizePhoneForMatch(evt.from.replace(/@c\.us$/, ''));
    const at = evt.timestamp ? new Date(evt.timestamp) : new Date();
    const body = (evt.body ?? '').trim();

    if (evt.externalMessageId) {
      const seen = await this.prisma.whatsAppMessage.findUnique({
        where: { externalMessageId: evt.externalMessageId },
      });
      if (seen) return { ok: true, applied: false }; // نفس الرسالة وصلت مرتين
    }

    // **مصافحة التحقق أولاً وقبل أي تصنيف.** رسالة «AQUAGO VERIFY ####» ليست
    // ردّ وكالة ولا انسحاباً من حملة: هي خطوة دخولٍ لشخص لا حساب له بعد.
    // تمريرها على منطق الحملات كان سيقيّدها على lead لا علاقة له بها، وقد
    // يُحتسب رمزها كلمةَ انسحاب لو صادف أن حواها.
    if (await this.auth.confirmWhatsappHandshake(phone, body)) {
      // تُسجَّل كواردة كسائر الرسائل (أثرٌ للتشخيص) ولا تمضي أبعد.
      await this.prisma.whatsAppMessage.create({
        data: {
          phoneNumber: phone,
          direction: 'INBOUND',
          messageType: 'TEXT',
          // النصّ لا يُخزَّن: يحوي رمز مصافحة صالحاً لدقائق، ولا داعي
          // لبقائه في جدول يقرأه من يراجع الحملات.
          body: null,
          externalMessageId: evt.externalMessageId ?? null,
          status: 'RECEIVED',
        },
      });
      return { ok: true, applied: true, matchedLead: false, handshake: true };
    }

    const contact = await this.prisma.agencyWhatsAppContact.findFirst({
      where: { phoneNumber: phone },
      include: { lead: true },
    });
    const leadId = contact?.leadId ?? null;

    // آخر رسالة صادرة لهذا الرقم — إليها يُنسب الردّ
    const lastOutbound = leadId
      ? await this.prisma.whatsAppMessage.findFirst({
          where: { leadId, direction: 'OUTBOUND', phoneNumber: phone },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    await this.prisma.whatsAppMessage.create({
      data: {
        leadId,
        campaignId: lastOutbound?.campaignId ?? null,
        recipientId: lastOutbound?.recipientId ?? null,
        phoneNumber: phone,
        direction: 'INBOUND',
        messageType: 'TEXT',
        body: body || null,
        externalMessageId: evt.externalMessageId ?? null,
        status: 'RECEIVED',
      },
    });

    if (!leadId) {
      // رقم لا نعرفه كوكالة قد يكون مستخدماً أو عضو قائمة — انسحابه يسري
      // على أي حال. الانسحاب حقٌّ للرقم لا امتيازٌ لمن له سجل عندنا.
      if (OPT_OUT_WORDS.some((w) => body.toLowerCase().includes(w))) {
        await this.suppressGlobally(phone, body);
        return { ok: true, applied: true, matchedLead: false, optedOut: true };
      }
      return { ok: true, applied: true, matchedLead: false };
    }

    const lower = body.toLowerCase();
    const optedOut = OPT_OUT_WORDS.some((w) => lower.includes(w));
    if (optedOut) {
      await this.suppressGlobally(phone, body);
      await this.leads.optOutByPhone(phone, 'رد وارد على واتساب');
      await this.markReplied(lastOutbound?.recipientId, lastOutbound?.campaignId, at, 'OPTED_OUT');
      await this.prisma.agencyOutreach.create({
        data: {
          leadId,
          channel: 'WHATSAPP',
          contactType: 'FOLLOW_UP',
          phoneNumber: phone,
          campaignId: lastOutbound?.campaignId ?? null,
          status: 'OPTED_OUT',
          respondedAt: at,
          notes: body || null,
        },
      });
      return { ok: true, applied: true, optedOut: true };
    }

    const interested = INTEREST_WORDS.some((w) => lower.includes(w));
    await this.prisma.agencyLead.update({
      where: { id: leadId },
      data: {
        responseStatus: interested ? 'INTERESTED' : 'RESPONDED',
        interested: interested || undefined,
        lastResponseAt: at,
      },
    });
    await this.markReplied(lastOutbound?.recipientId, lastOutbound?.campaignId, at, 'REPLIED');
    await this.prisma.agencyOutreach.create({
      data: {
        leadId,
        channel: 'WHATSAPP',
        contactType: 'FOLLOW_UP',
        phoneNumber: phone,
        campaignId: lastOutbound?.campaignId ?? null,
        status: 'REPLIED',
        respondedAt: at,
        notes: body || null,
      },
    });
    return { ok: true, applied: true, interested };
  }

  /**
   * إدخال الرقم في قائمة المنع العامة — فوراً وبلا مراجعة.
   *
   * كل تأخير هنا يعني رسالة أخرى إلى من طلب ألا تصله. و`upsert` لأن الانسحاب
   * المكرر ليس خطأً: من يكتب «إلغاء» مرتين يريد الشيء نفسه.
   */
  private async suppressGlobally(phone: string, body: string) {
    await this.prisma.whatsAppOptOut.upsert({
      where: { phoneNumber: phone },
      create: {
        phoneNumber: phone,
        source: 'ردّ وارد على واتساب',
        reason: body.slice(0, 200) || null,
      },
      update: {},
    });
  }

  /** ردّ واحد لكل مستلم في العدّاد — ردّان لا يعنيان مستلمَين */
  private async markReplied(
    recipientId: string | null | undefined,
    campaignId: string | null | undefined,
    at: Date,
    status: 'REPLIED' | 'OPTED_OUT',
  ) {
    if (!recipientId) return;
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: recipientId },
    });
    if (!recipient || recipient.repliedAt) return;
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status, repliedAt: at },
      }),
      ...(campaignId
        ? [
            this.prisma.whatsAppCampaign.update({
              where: { id: campaignId },
              data:
                status === 'OPTED_OUT'
                  ? { optedOutCount: { increment: 1 }, repliedCount: { increment: 1 } }
                  : { repliedCount: { increment: 1 } },
            }),
          ]
        : []),
    ]);
  }
}
