import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { normalizeJordanPhone } from '../common/phone.util';
import { WHATSAPP_PROVIDER, type IWhatsAppProvider } from './whatsapp-provider';

/**
 * لوحة حالة بوابة OpenWA وأدوات فحصها.
 *
 * سببها أن البوابة كانت صندوقاً أسود: تُضبط بمتغيّرات بيئة ولا يعرف أحد من
 * اللوحة هل هي متصلة، ولا لماذا لا تصل الرسائل. أول سؤال عند تعطّل حملة هو
 * «هل الجلسة حيّة؟» ولم يكن له جواب إلا من سجلّات الخادم.
 *
 * **لا تكشف الأسرار.** مفتاح الـAPI لا يخرج من هنا بحال — يُقال إنه معرَّف
 * أو غير معرَّف فقط. أما رابط الأحداث فيخرج كاملاً بسرّه لأن من يراه يملك
 * صلاحية إدارة الحملات أصلاً، وهو الشخص نفسه الذي سيلصقه في إعداد البوابة.
 */
@Injectable()
export class WhatsAppAdminService {
  constructor(
    private prisma: PrismaV2Service,
    @Inject(WHATSAPP_PROVIDER) private provider: IWhatsAppProvider,
  ) {}

  async status(publicBaseUrl: string | undefined) {
    const campaignChannel = process.env.WHATSAPP_CAMPAIGN_PROVIDER || 'openwa';
    const provider = process.env.WHATSAPP_PROVIDER || 'dev';
    const configured = {
      // قناة الحملات قد تختلف عن قناة رموز التحقق — والشاشة يجب أن تقول أيّهما
      campaignChannel,
      meta: {
        phoneNumberId: process.env.META_PHONE_NUMBER_ID || null,
        wabaId: process.env.META_WABA_ID || null,
        accessTokenSet: !!process.env.META_ACCESS_TOKEN,
        appSecretSet: !!process.env.META_APP_SECRET,
        verifyTokenSet: !!process.env.META_WEBHOOK_VERIFY_TOKEN,
        apiVersion: process.env.META_API_VERSION || 'v23.0',
      },
      provider,
      apiUrl: process.env.WHATSAPP_API_URL || null,
      // المفتاح لا يخرج — وجوده وحده هو الخبر
      apiKeySet: !!process.env.WHATSAPP_API_KEY,
      sessionId: process.env.WHATSAPP_SESSION_ID || null,
      statusPath: process.env.WHATSAPP_STATUS_PATH || '/api/sessions/{sessionId}',
      webhookSecretSet: !!process.env.WHATSAPP_WEBHOOK_SECRET,
      sendSpacingMs: Number(process.env.WHATSAPP_SEND_SPACING_MS || 8000),
    };

    // الفحص الحيّ قد يتأخر أو يفشل — لا يجوز أن يعلّق الشاشة كلها
    const connection = await this.provider
      .getConnectionStatus()
      .catch(() => 'unknown' as const);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [running, sent24h, failed24h, inbound24h, lastOutbound] = await Promise.all([
      this.prisma.whatsAppCampaign.count({ where: { status: 'RUNNING' } }),
      this.prisma.whatsAppMessage.count({
        where: { direction: 'OUTBOUND', createdAt: { gte: since } },
      }),
      this.prisma.whatsAppMessage.count({
        where: { direction: 'OUTBOUND', status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.whatsAppMessage.count({
        where: { direction: 'INBOUND', createdAt: { gte: since } },
      }),
      this.prisma.whatsAppMessage.findFirst({
        where: { direction: 'OUTBOUND' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, status: true, phoneNumber: true },
      }),
    ]);

    const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
    return {
      configured,
      connection,
      // رابط webhook متى — يُلصق في Meta → WhatsApp → Configuration
      metaWebhookUrl: publicBaseUrl
        ? `${publicBaseUrl.replace(/\/$/, '')}/api/v2/whatsapp/meta`
        : null,
      // الرابط الذي يُلصق في إعداد البوابة لتصل أحداث التسليم والرسائل الواردة
      webhookUrl:
        secret && publicBaseUrl
          ? `${publicBaseUrl.replace(/\/$/, '')}/api/v2/whatsapp/events/${secret}`
          : null,
      activity: { running, sent24h, failed24h, inbound24h, lastOutbound },
    };
  }

  /**
   * رسالة فحص إلى رقم يكتبه المسؤول.
   *
   * الغاية إثبات أن السلسلة كلها تعمل — البوابة والجلسة والرقم — قبل إطلاق
   * حملة على مئات الناس واكتشاف العطل من فشلها. تُسجَّل كأي رسالة صادرة
   * (بلا حملة) ويُكتب لها سطر تدقيق باسم من أرسلها: أداةٌ تُرسل إلى أرقام
   * حقيقية لا تُترك بلا أثر.
   */
  async sendTest(rawPhone: string, text: string | undefined, actorId: string) {
    const phone = normalizeJordanPhone(rawPhone);
    if ((await this.provider.getConnectionStatus()) === 'disconnected') {
      throw new BadRequestException(
        'البوابة غير متصلة — تحقّق من الجلسة قبل الإرسال',
      );
    }
    const body =
      `رسالة فحص من منصة AquaGo` + (text?.trim() ? `\n${text.trim()}` : '');

    let externalMessageId: string | null = null;
    let error: string | null = null;
    try {
      ({ externalMessageId } = await this.provider.sendTextMessage(phone, body));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    await this.prisma.whatsAppMessage.create({
      data: {
        phoneNumber: phone,
        direction: 'OUTBOUND',
        messageType: 'TEXT',
        body,
        externalMessageId,
        status: error ? 'FAILED' : 'SENT',
        errorMessage: error,
        sentAt: error ? null : new Date(),
        failedAt: error ? new Date() : null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'whatsapp.test-message',
        entityType: 'WhatsAppMessage',
        entityId: externalMessageId ?? phone,
        newValue: { phone, ok: !error } as Prisma.InputJsonValue,
      },
    });

    if (error) throw new BadRequestException(`فشل الإرسال: ${error}`);
    return { ok: true, externalMessageId };
  }
}
