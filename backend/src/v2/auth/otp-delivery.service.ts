import { Injectable, Logger } from '@nestjs/common';
import type { OtpChannel } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { EmailService } from './email.service';
import { MetaWhatsappService } from './meta-whatsapp.service';
import { WhatsappService } from './whatsapp.service';

/** ما يُرجَع للوحة والسجل — أي قناة استُعملت فعلاً ولماذا */
export interface OtpDeliveryResult {
  channel: OtpChannel;
  /** القناة التي اختارها الإعداد قبل أي سقوط اضطراري */
  requestedChannel: OtpChannel;
  /** وجهة الإرسال كما استُعملت (رقم أو بريد) — للتشخيص لا للعرض للمستخدم */
  target: string;
  /** هل جاء الاختيار من استثناء على الرقم لا من الإعداد العام؟ */
  fromOverride: boolean;
}

/**
 * **الموزِّع**: يقرّر بأي قناة يُرسَل رمز التحقق، ثم يُرسله.
 *
 * الترتيب: استثناء الرقم أولاً، وإلا القناة العامة، وإلا OPENWA.
 *
 * **القراءة عند كل إرسال بلا ذاكرة وسيطة.** هذا هو ما يجعل تبديل الأدمن
 * يسري في اللحظة: أي تخزين مؤقّت — ولو لدقيقة — يعني أن من طلب رمزاً بعد
 * التبديل مباشرة يذهب طلبه إلى البوابة المعطَّلة التي بدّلها الأدمن هرباً
 * منها. الاستعلام صفّان بمفتاح أساسي، وثمنه لا يُقارن بذلك.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private prisma: PrismaV2Service,
    private whatsapp: WhatsappService,
    private metaWhatsapp: MetaWhatsappService,
    private email: EmailService,
  ) {}

  /** القناة العامة — تُنشأ بالافتراضي عند أول قراءة فلا تحتاج بذرة */
  async currentChannel(): Promise<OtpChannel> {
    const row = await this.prisma.otpChannelSettings.findUnique({ where: { id: 1 } });
    return row?.channel ?? 'OPENWA';
  }

  /** القناة السارية على رقم بعينه، مع مصدر القرار */
  async resolveFor(
    phone: string,
  ): Promise<{ channel: OtpChannel; fromOverride: boolean; overrideEmail: string | null }> {
    const override = await this.prisma.otpChannelOverride.findUnique({
      where: { phone },
    });
    if (override) {
      return {
        channel: override.channel,
        fromOverride: true,
        overrideEmail: override.email,
      };
    }
    return {
      channel: await this.currentChannel(),
      fromOverride: false,
      overrideEmail: null,
    };
  }

  /**
   * يرسل الرمز بالقناة السارية.
   *
   * **السقوط إلى واتساب حين يتعذّر البريد**: قناة البريد بلا عنوان معروف لا
   * تُرسل شيئاً، ولو تركناها تفشل لبقي صاحب الرقم بلا رمز ولا تفسير — وهو
   * الذي لم يختر القناة أصلاً. فيُرسَل على واتساب ويُسجَّل السبب، لأن وصول
   * الرمز أولى من التزام قناة اختارها غيره.
   */
  async sendOtp(
    phone: string,
    code: string,
    ttlMinutes: number,
  ): Promise<OtpDeliveryResult> {
    const { channel, fromOverride, overrideEmail } = await this.resolveFor(phone);
    // **الرمز وحده على سطره.** الضغط المطوّل في واتساب يحدّد السطر لا
    // الكلمة، فرمزٌ ملتصق بجملة يُنسخ معها ويضطر صاحبه إلى تشذيبه بيده
    // داخل حقلٍ لا يقبل غير الأرقام. سطرٌ مفرد يُنسخ جاهزاً للّصق.
    const text =
      `رمز التحقق من AquaGo\n\n` +
      `${code}\n\n` +
      `صالح لمدة ${ttlMinutes} دقائق. لا تشارك الرمز مع أي شخص.`;

    if (channel === 'EMAIL') {
      const to = overrideEmail ?? (await this.emailOf(phone));
      if (!to) {
        this.logger.warn(
          `قناة البريد مطلوبة لـ${phone} بلا عنوان معروف — أُرسل على واتساب بدلاً منها`,
        );
        await this.whatsapp.send(phone, text);
        return { channel: 'OPENWA', requestedChannel: channel, target: phone, fromOverride };
      }
      await this.email.sendOtp(to, code, ttlMinutes);
      return { channel, requestedChannel: channel, target: to, fromOverride };
    }

    if (channel === 'META_WHATSAPP') {
      await this.metaWhatsapp.sendOtp(phone, code);
      return { channel, requestedChannel: channel, target: phone, fromOverride };
    }

    await this.whatsapp.send(phone, text);
    return { channel: 'OPENWA', requestedChannel: 'OPENWA', target: phone, fromOverride };
  }

  /** بريد الحساب صاحب هذا الرقم — من دخل بجوجل يحمله، وغيره قد لا يحمله */
  private async emailOf(phone: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { email: true },
    });
    return user?.email ?? null;
  }
}
