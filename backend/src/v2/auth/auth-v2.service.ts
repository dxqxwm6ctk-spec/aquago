import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { User } from '@prisma-v2/client';
import type Redis from 'ioredis';
import {
  FirebaseAdminService,
  FirebaseNotConfiguredError,
} from '../firebase/firebase-admin.service';
import { normalizeJordanPhone, toJordanE164 } from '../common/phone.util';
import { ReviewAccountService } from '../review-account/review-account.service';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { SESSION_REVOKED_AR } from './jwt-v2.guard';
import { REDIS } from '../redis/redis.module';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';
import {
  assertValidPassword,
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from './password.util';
import { WhatsappService } from './whatsapp.service';
import { OtpDeliveryService } from './otp-delivery.service';

const ACCESS_TOKEN_TTL = '15m'; // قصير — الصلاحيات تُقرأ من القاعدة لا من التوكن
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// قفل تخمين كلمات المرور: اللوحات على الإنترنت ولا تحميها مهلة OTP
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCK_SECONDS = 15 * 60;
// يمنع إغراق Firebase Admin (تكلفة/حصة) وطلبات refresh بلا حساب مستخدم يقيّدها
const IP_FLOOD_MAX = 20;
const IP_FLOOD_WINDOW_SECONDS = 15 * 60;

// رمز واتساب: مخزَّن بـRedis فقط بـTTL (لا جدول OtpCode المهمَل) — نمط
// انطلاق مؤقت ريثما يُحسم بديل رسمي أو محلي دائم.
const WHATSAPP_OTP_TTL_SECONDS = 5 * 60;
/**
 * مهلة مصافحة واتساب — من ضغط «تحقق عبر واتساب» إلى وصول رسالته.
 *
 * أطول من مهلة الرمز عمداً: هنا يفتح المستخدم تطبيقاً آخر ويبحث عن المحادثة
 * ويضغط إرسال، وقد يقاطعه شيء في الطريق. خمس دقائق كانت ستُسقط جلسة من
 * تأخّر دقيقتين فيعيد الكرّة من الصفر بلا ذنب.
 */
const WA_HANDSHAKE_TTL_SECONDS = 10 * 60;
/// طول رمز المصافحة — ستّ خانات من أبجدية بلا أحرف ملتبسة (انظر newHandshakeToken)
const WA_HANDSHAKE_TOKEN_LENGTH = 6;
const WHATSAPP_OTP_REQUEST_MAX = 5;
const WHATSAPP_OTP_REQUEST_WINDOW_SECONDS = 15 * 60;
const WHATSAPP_OTP_VERIFY_MAX = 8;
const WHATSAPP_OTP_VERIFY_WINDOW_SECONDS = 15 * 60;

/** مهلة التبريد بين تعديلَي اسم — الاسم هوية أمام السائق لا حقل تجميل */
const NAME_CHANGE_COOLDOWN_DAYS = 30;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 50;
// حدّ قصير المدى فوق مهلة التبريد: التبريد يمنع التعديل المتكرر، وهذا يمنع
// قصف المسار بمحاولات مرفوضة (كل واحدة استعلام قاعدة بيانات).
const NAME_CHANGE_ATTEMPT_MAX = 5;
const NAME_CHANGE_ATTEMPT_WINDOW_SECONDS = 15 * 60;

/**
 * بريد ترحيل آبل: يُولَّد عنوان فريد لكل تطبيق حين يختار الزبون «إخفاء
 * بريدي». يصلح للمراسلة (آبل تُمرّرها إلى بريده الحقيقي) ولا يصلح للمطابقة —
 * لا يساوي بريده لدى جوجل ولا ما كتبه عند التسجيل بواتساب.
 */
/**
 * بادئة رسالة المصافحة. تُعرض للمستخدم في نصّ يرسله بنفسه، فهي بالإنجليزية
 * وواضحة الغرض: من يقرأ محادثته لاحقاً يفهم ما أرسل ولماذا.
 */
const WA_HANDSHAKE_PREFIX = 'AQUAGO VERIFY';

/*
 * متغيّرات البيئة التي يحتاجها مسار المصافحة:
 *
 *   WHATSAPP_GATEWAY_NUMBER  الرقم الذي يراسله المستخدم — رقم الجلسة
 *                            المتصلة بالبوابة نفسه. بصيغة دولية (+9627…).
 *                            غيابه يُعطّل المسار كلّه ويُبقي الإرسال المباشر.
 *   WHATSAPP_WEBHOOK_SECRET  سرّ مسار استقبال الأحداث (قائم أصلاً). بلا
 *                            توجيه أحداث الرسائل الواردة من البوابة إلى
 *                            `/v2/whatsapp/events/{secret}` لن تصل رسالة
 *                            المستخدم أبداً وستنتهي كل مصافحة بالمهلة.
 */

/**
 * يستخرج رمز المصافحة من نصّ رسالة واردة.
 *
 * **متساهل في الشكل متشدّد في الرمز.** المستخدم قد يزيد تحية قبل النصّ أو
 * يكتبه بحروف صغيرة أو يبتلع واتساب مسافةً — ورفضُ ذلك يعني مصافحةً تفشل
 * وهو فعل ما طُلب منه تماماً. أما الرمز نفسه فبطول وأبجدية محدَّدين، فلا
 * يُلتقط من كلام عابر ما ليس رمزاً.
 */
const extractHandshakeToken = (body: string): string | null => {
  // كل فراغ في البادئة يقبل فراغاً أو أكثر: واتساب يلفّ السطر الطويل وقد
  // يضاعف المسافة، ونسخ ولصق يُدخل أحياناً فراغاً غير معتاد.
  const prefix = WA_HANDSHAKE_PREFIX.split(/\s+/).join('\\s+');
  const m = new RegExp(
    `${prefix}\\s*[:\\-]?\\s*([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{${WA_HANDSHAKE_TOKEN_LENGTH}})`,
    'i',
  ).exec(body ?? '');
  return m ? m[1].toUpperCase() : null;
};

const isPrivateRelayEmail = (email: string) =>
  email.endsWith('@privaterelay.appleid.com');

/** لا يخرج passwordHash من الخدمة أبداً */
/**
 * نسخة شروط الاستخدام السارية. رفعها يعني أن كل من قَبِل النسخة السابقة
 * يُسأل من جديد — فلا ترفعها لتصحيح إملائي، بل حين يتغيّر ما التزم به.
 */
export const TERMS_VERSION = '1';

export const publicUser = (u: User) => {
  const { passwordHash: _drop, ...rest } = u;
  return {
    ...rest,
    // ما تحتاجه الشاشة: هل يُسأل عن الشروط الآن؟ الحساب الذي قَبِل نسخة
    // قديمة يُعامَل كمن لم يقبل — الموافقة على نصٍّ آخر ليست موافقة.
    termsAccepted: !!u.termsAcceptedAt && u.termsVersion === TERMS_VERSION,
    termsVersion: TERMS_VERSION,
    // وهل يُطلب منه توثيق رقمه الآن؟ التطبيق يسأل الخادم ولا يستنتج: هو
    // وحده يعرف أن الرقم وُثِّق سابقاً من جهاز آخر أو قبل مسح بيانات التطبيق.
    phoneVerified: !!u.phoneVerifiedAt,
    // وهل أقرّ اسمه بعد؟ الاسم الآتي من جوجل لم يختره أحد لهذه الخدمة،
    // والسائق ينادي به — فيُعرض للتأكيد مرة واحدة عند أول دخول.
    nameConfirmed: !!u.nameConfirmedAt,
  };
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthV2Service {
  private readonly logger = new Logger(AuthV2Service.name);

  constructor(
    private prisma: PrismaV2Service,
    private jwt: JwtService,
    private firebaseAdmin: FirebaseAdminService,
    private whatsapp: WhatsappService,
    private otpDelivery: OtpDeliveryService,
    private gateway: TrackingV2Gateway,
    private reviewAccount: ReviewAccountService,
    @Inject(REDIS) private redis: Redis,
  ) {}

  /**
   * حساب لوحة = يحمل دور منصة أو دور وكالة غير DRIVER. هؤلاء يدخلون باسم
   * المستخدم وكلمة المرور فقط: تسجيل الدخول برقم الهاتف وسيلة ميدانية،
   * ولا يجوز لرقم موظف/مسؤول أن يتجاوز كلمة المرور عبره.
   */
  private async isDashboardAccount(userId: string): Promise<boolean> {
    const staffRole = await this.prisma.userRole.findFirst({
      where: {
        userId,
        OR: [{ role: { scope: 'PLATFORM' } }, { role: { scope: 'AGENCY', name: { not: 'DRIVER' } } }],
      },
    });
    return !!staffRole;
  }

  /**
   * **التحقق من ID token — مع فصل عطل الخادم عن توكن المستخدم.**
   *
   * كان `catch` واحد يبتلع السببين ويردّ 401 على كليهما، فبدا الخادمُ غيرُ
   * المهيَّأ (حساب خدمة غائب) كتوكن مزوَّر: يُقرأ العطل في التطبيق والمزوّد
   * وموضعه متغيّرُ بيئةٍ فارغ — وهو ما كلّف تشخيصاً طويلاً فعلاً.
   *
   * 503 لا 401 لعطل التهيئة: الحالة صحيحة دلالةً (خدمة غير متاحة)، وتمنع
   * التطبيقَ من مسح توكناته — معالج الـ401 عنده يُنهي الجلسة، فكان عطلٌ
   * عابر في الخادم يُخرج كل من يفتح التطبيق أثناءه.
   *
   * الرسالة للمستخدم تبقى عامة: سببُ العطل الحقيقي يُسجَّل عندنا ولا يُسرَّب
   * في الرد — نصُّه يصف بنية إعدادنا الداخلية.
   */
  private async verifyFirebaseToken(idToken: string, context: string, invalidTokenMessage: string) {
    try {
      return await this.firebaseAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      if (e instanceof FirebaseNotConfiguredError) {
        this.logger.error(`[${context}] تهيئة Firebase مفقودة: ${e.message}`);
        throw new ServiceUnavailableException(
          'خدمة الدخول غير متاحة مؤقتاً — حاول بعد قليل',
        );
      }
      throw new UnauthorizedException(invalidTokenMessage);
    }
  }

  /**
   * تسجيل الدخول الميداني (زبون/سائق): يتحقق من ID token صادر عن Firebase
   * Phone Auth بعد ما التطبيق أرسل واستقبل رمز الـ SMS مباشرة من Firebase —
   * الخادم لا يرسل ولا يخزّن أي رمز تحقق بنفسه بعد الآن.
   */
  async firebaseLogin(
    idToken: string,
    name: string | undefined,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    await this.assertIpNotFlooded('firebase-login', ip);
    const decoded = await this.verifyFirebaseToken(
      idToken,
      'firebase-login',
      'رمز تحقق غير صالح أو منتهي',
    );
    const rawPhone = decoded.phone_number;
    if (!rawPhone) {
      throw new UnauthorizedException('رمز التحقق لا يحمل رقم هاتف');
    }
    return this.loginByPhone(normalizeJordanPhone(rawPhone), name, deviceInfo, ip);
  }

  /**
   * **دخول جوجل — المسار الأساسي للزبون** (قرار 2026-08-30).
   *
   * لماذا حلّ محل الدخول برقم الهاتف: كل دخول برقم كان يستهلك رصيد بوابة
   * الرسائل، ودخولُ زبونٍ عائد لا يثبت شيئاً جديداً — هو أثبت ملكية رقمه أول
   * مرة. جوجل يتكفّل بالتحقق مجاناً وبلا رمز، والرقم يُوثَّق مرة واحدة عند
   * أول طلب حيث يكون له معنى فعلي (السائق سيتصل به).
   *
   * الهوية هي `uid` من Firebase لا البريد: الزبون قد يبدّل بريده لدى جوجل
   * والـuid ثابت مدى الحياة، فربط الحساب بالبريد كان سيُنشئ حساباً جديداً
   * لنفس الشخص عند أول تغيير.
   *
   * الحساب يُنشأ بلا هاتف — `phone = null` مسموح بالمخطط. وهذا سبب أن كل ما
   * يتصل بالطلب يمرّ بـ`assertPhoneVerified` قبل أن يمضي.
   */
  async googleLogin(
    idToken: string,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    return this.socialLogin('google', idToken, deviceInfo, ip);
  }

  /**
   * **دخول آبل** — نظير [googleLogin] لمستخدمي iOS. تشترطه آبل على كل تطبيق
   * يعرض دخولاً بمزوّد خارجي (Guideline 4.8)، فبقاء جوجل وحده يعني رفض
   * النسخة عند المراجعة.
   *
   * يمرّ بـFirebase كما يمرّ جوجل: التطبيق يبادل هوية آبل بجلسة Firebase ثم
   * يسلّم الـID token هنا، فالتحقق واحد لكلا المسارين ولا نتعامل مع مفاتيح
   * آبل ولا نتحقق من توقيعها بأنفسنا.
   *
   * **البريد قد يكون مُخفى**: من اختار «إخفاء بريدي» يصل بعنوان ترحيل
   * `@privaterelay.appleid.com` صالح للمراسلة لا للمطابقة. نخزّنه كما هو —
   * فالرسائل تصل عبره — ولا نربط به حساباً قائماً، وذلك في [socialLogin].
   */
  async appleLogin(
    idToken: string,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    return this.socialLogin('apple', idToken, deviceInfo, ip);
  }

  /**
   * الجذع المشترك لدخول جوجل وآبل — التحقق واحد والاختلاف في عمود الهوية
   * وحده. جُمعا عمداً: مساران متطابقان إلا في اسم حقل كانا سيفترقان مع أول
   * تعديل يُطبَّق على أحدهما وحده.
   *
   * الهوية هي `uid` من Firebase لا البريد: الزبون قد يبدّل بريده لدى المزوّد
   * والـuid ثابت مدى الحياة، فربط الحساب بالبريد كان سيُنشئ حساباً جديداً
   * لنفس الشخص عند أول تغيير.
   *
   * الحساب يُنشأ بلا هاتف — `phone = null` مسموح بالمخطط. وهذا سبب أن كل ما
   * يتصل بالطلب يمرّ بـ`assertPhoneVerified` قبل أن يمضي.
   */
  private async socialLogin(
    provider: 'google' | 'apple',
    idToken: string,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    const uidField = provider === 'google' ? 'googleUid' : 'appleUid';
    const providerLabel = provider === 'google' ? 'جوجل' : 'آبل';

    await this.assertIpNotFlooded(`${provider}-login`, ip);
    const decoded = await this.verifyFirebaseToken(
      idToken,
      `${provider}-login`,
      `تعذّر التحقق من حساب ${providerLabel} — أعد المحاولة`,
    );

    const uid = decoded.uid;
    const email = decoded.email?.trim().toLowerCase() || null;
    // الاسم من المزوّد: يوفّر على الزبون كتابته، ويبقى قابلاً للتعديل لاحقاً
    // من شاشة الحساب. غيابه لا يمنع الدخول — نضع بديلاً مؤقتاً بدل أن نرفض
    // حساباً سليماً على حقل تجميلي. وآبل تحديداً لا ترسل الاسم إلا في أول
    // دخول للحساب، فالغياب هنا هو الحالة الغالبة لا الاستثناء.
    const nameFromProvider = (decoded.name as string | undefined)?.trim();

    // الحقل يُختار بمتغيّر، وPrisma يتوقّع مفتاحاً حرفياً — الوسيط يحمل
    // النوعين معاً فيبقى الخطأ المطبعي في اسم الحقل مرصوداً عند الترجمة.
    const uidWhere: { googleUid?: string; appleUid?: string } = {
      [uidField]: uid,
    };

    let user = await this.prisma.user.findUnique({
      where: uidWhere as { googleUid: string } | { appleUid: string },
    });

    // زبون قديم (دخل بواتساب أو بالمزوّد الآخر) يعود بنفس البريد: نتبنّاه بدل
    // أن نُنشئ له حساباً ثانياً يفقد طلباته وعناوينه. البريد وحده كافٍ هنا
    // لأن المزوّد تحقّق منه — لا يدّعيه المستخدم.
    //
    // بريد الترحيل مستثنى: `@privaterelay.appleid.com` عنوان يُولَّد لكل
    // تطبيق على حدة ولا يطابق بريد الزبون الحقيقي أبداً، فالمطابقة به لا
    // تُفيد ربطاً — وأسوأ منه أن نثبّته على حساب قائم فنفقد بريده الحقيقي.
    if (!user && email && !isPrivateRelayEmail(email)) {
      const byEmail = await this.prisma.user.findUnique({ where: { email } });
      if (byEmail && !byEmail[uidField]) {
        user = await this.prisma.user.update({
          where: { id: byEmail.id },
          data: uidWhere,
        });
      }
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          ...uidWhere,
          email,
          name: nameFromProvider || 'زبون جديد',
        },
      });
    } else if (email && user.email !== email) {
      // البريد لدى المزوّد تغيّر — نُحدّثه ما لم يكن محجوزاً لحساب آخر. الفشل
      // هنا لا يُفشل الدخول: البريد بيان تواصل، والهوية هي الـuid وهي سليمة.
      await this.prisma.user
        .update({ where: { id: user.id }, data: { email } })
        .catch(() => undefined);
    }

    return this.finishLogin(user, deviceInfo, ip);
  }

  /**
   * توثيق رقم الهاتف لحساب داخلٍ أصلاً (دخل بجوجل) — الخطوة التي تسبق أول
   * طلب. مسار منفصل عن `requestWhatsappOtp` عمداً: ذاك يُنشئ جلسة لمجهول،
   * وهذا يضيف رقماً لصاحب جلسة قائمة، فحدوده مربوطة بالحساب لا بالرقم وحده.
   */
  async requestPhoneVerification(
    userId: string,
    rawPhone: string,
    ip: string | undefined,
  ) {
    const phone = normalizeJordanPhone(rawPhone);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة');

    // موثَّق أصلاً: لا نُرسل رمزاً ولا نستهلك رصيداً. التوثيق مرة واحدة للأبد.
    if (user.phoneVerifiedAt) {
      return { phone: user.phone, alreadyVerified: true };
    }

    await this.assertNotFlooded(
      'phone-verify-request',
      userId,
      WHATSAPP_OTP_REQUEST_MAX,
      WHATSAPP_OTP_REQUEST_WINDOW_SECONDS,
    );
    await this.assertIpNotFlooded('phone-verify-request', ip);
    await this.assertPhoneFree(phone, userId);

    // رقم المراجعة: يمرّ بلا إرسال، تماماً كمسار الدخول القديم.
    if (await this.reviewAccount.isReviewPhone(phone)) {
      return { phone, message: 'تم إرسال رمز التحقق عبر واتساب' };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.redis.set(
      this.whatsappOtpKey(phone),
      code,
      'EX',
      WHATSAPP_OTP_TTL_SECONDS,
    );
    // القناة يقرّرها الأدمن من اللوحة (عامة أو استثناء لهذا الرقم)،
    // وتُقرأ عند كل إرسال فيسري التبديل في اللحظة — OtpDeliveryService
    await this.otpDelivery.sendOtp(phone, code, WHATSAPP_OTP_TTL_SECONDS / 60);

    const exposeCode = !this.whatsapp.isRealProvider;
    return {
      phone,
      message: 'تم إرسال رمز التحقق عبر واتساب',
      ...(exposeCode ? { devCode: code } : {}),
    };
  }

  /** يتحقق من الرمز ثم يثبّت الرقم موثَّقاً على الحساب — مرة واحدة للأبد */
  async confirmPhoneVerification(
    userId: string,
    rawPhone: string,
    code: string,
  ) {
    const phone = normalizeJordanPhone(rawPhone);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الجلسة غير صالحة');
    if (user.phoneVerifiedAt) return publicUser(user);

    await this.assertNotFlooded(
      'phone-verify-confirm',
      userId,
      WHATSAPP_OTP_VERIFY_MAX,
      WHATSAPP_OTP_VERIFY_WINDOW_SECONDS,
    );

    const isReview = await this.reviewAccount.isReviewLogin(phone, code);
    if (!isReview) {
      const key = this.whatsappOtpKey(phone);
      const stored = await this.redis.get(key);
      if (!stored || stored !== code) {
        throw new UnauthorizedException('رمز التحقق غير صحيح أو منتهي');
      }
      await this.redis.del(key); // استخدام واحد فقط
    }

    // يُعاد الفحص بعد التحقق لا قبله فقط: قد يكون رقمٌ حُجز لحساب آخر خلال
    // الدقائق الخمس بين الإرسال والتأكيد.
    await this.assertPhoneFree(phone, userId);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { phone, phoneVerifiedAt: new Date() },
    });
    return publicUser(updated);
  }

  /**
   * الرقم غير مرتبط بحساب آخر. القرار (2026-08-30) رفضٌ صريح لا دمج تلقائي:
   * دمج حسابين يعني نقل طلبات ومحفظة وعناوين بين هويتين بناءً على رقم وحده،
   * وخطؤه لا يُراجَع. الدعم يتحقق يدوياً ويدمج عند الحاجة.
   */
  private async assertPhoneFree(phone: string, userId: string): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { phone } });
    if (owner && owner.id !== userId) {
      throw new ForbiddenException(
        'هذا الرقم مسجّل بحساب آخر — تواصل مع الدعم لربطه بحسابك',
      );
    }
  }

  private whatsappOtpKey(phone: string): string {
    return `whatsapp-otp:${phone}`;
  }

  /**
   * مفتاح المصافحة **بالرمز لا بالرقم**.
   *
   * هذا هو ما يمنع انتحال الجلسات: الرسالة الواردة تحمل الرمز، فنقرأ منها
   * أي جلسةٍ قُصدت ثم نطابق رقم المرسِل بالرقم المخزَّن فيها. لو كان المفتاح
   * الرقمَ لَما استطعنا العثور على الجلسة إلا بالرقم الوارد وحده — ومن راسل
   * الرقم الرسمي لأي غرض كان ستُحتسب رسالته تحقّقاً لجلسة لم يفتحها.
   */
  private waHandshakeKey(token: string): string {
    return `wa-handshake:${token.toUpperCase()}`;
  }

  /** الجلسة المفتوحة لرقم بعينه — ليعيد التطبيق نفس الرمز إن سأل مرتين */
  private waHandshakePhoneKey(phone: string): string {
    return `wa-handshake-phone:${phone}`;
  }

  /**
   * رمز مصافحة قصير يُقرأ ويُكتب بلا لبس.
   *
   * الأبجدية بلا `0/O` و`1/I/L`: المستخدم قد يقرأ الرمز من الشاشة ويكتبه
   * بيده حين يفشل الملء المسبق (واتساب ويب، أو نسخة لا تدعم الرابط)، وحرفٌ
   * ملتبس واحد يعني مصافحةً تفشل بلا سبب ظاهر له.
   *
   * `randomBytes` لا `Math.random`: الرمز هو ما يربط الجلسة بصاحبها، ورمزٌ
   * يُتوقَّع يعني جلسةً تُنتحَل.
   */
  private newHandshakeToken(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(WA_HANDSHAKE_TOKEN_LENGTH);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  /**
   * إرسال رمز تحقق عبر واتساب (نسخة انطلاق مؤقتة بدل Firebase Phone Auth —
   * انظر قرار 2026-08-02 حول OtpCode المهمَل). الرمز بـRedis فقط، TTL خمس
   * دقائق، لا جدول قاعدة بيانات جديد.
   */
  async requestWhatsappOtp(rawPhone: string, ip: string | undefined) {
    const phone = normalizeJordanPhone(rawPhone);
    await this.assertNotFlooded(
      'whatsapp-otp-request',
      phone,
      WHATSAPP_OTP_REQUEST_MAX,
      WHATSAPP_OTP_REQUEST_WINDOW_SECONDS,
    );
    await this.assertIpNotFlooded('whatsapp-otp-request', ip);

    // رقم المراجعة لا يملك واتساب أصلاً: الإرسال إليه يفشل أو يذهب إلى رقم
    // غريب، ورمزه محفوظ في إعدادات المراجعة لا في Redis. نردّ كأن شيئاً
    // أُرسل حتى تسير شاشة التطبيق كما هي عند المراجِع.
    if (await this.reviewAccount.isReviewPhone(phone)) {
      return {
        phone,
        isRegistered: (await this.prisma.user.count({ where: { phone } })) > 0,
        message: 'تم إرسال رمز التحقق عبر واتساب',
      };
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.redis.set(this.whatsappOtpKey(phone), code, 'EX', WHATSAPP_OTP_TTL_SECONDS);
    // القناة يقرّرها الأدمن من اللوحة (عامة أو استثناء لهذا الرقم)،
    // وتُقرأ عند كل إرسال فيسري التبديل في اللحظة — OtpDeliveryService
    await this.otpDelivery.sendOtp(phone, code, WHATSAPP_OTP_TTL_SECONDS / 60);

    // هل الرقم مسجّل أصلاً؟ التطبيق يحتاجها ليقرر: يطلب الاسم من الجديد
    // وحده، ولا يسأل العائد عن اسم يملكه أصلاً. الاسم نفسه لا يُرجَع —
    // من يعرف رقماً لا يستحق أن يعرف صاحبه.
    const isRegistered =
      (await this.prisma.user.count({ where: { phone } })) > 0;

    // الرمز يُرجَع بالاستجابة فقط بلا بوابة حقيقية (تطوير محلي) — كما OTP القديم
    const exposeCode = !this.whatsapp.isRealProvider;
    return {
      phone,
      isRegistered,
      message: 'تم إرسال رمز التحقق عبر واتساب',
      ...(exposeCode ? { devCode: code } : {}),
    };
  }

  /**
   * هل مسار المصافحة متاح الآن؟ يسألها التطبيق قبل عرض شاشة الهاتف ليقرّر
   * أي واجهة يبني: زر «تحقق عبر واتساب» أم إرسال رمز مباشرةً.
   *
   * **شرطان معاً**: أن يكون الأدمن قد اختار OPENWA قناةً (فمع META أو
   * EMAIL يبقى المسار القديم كما هو — وهو ما طُلب)، وأن يكون رقم البوابة
   * مضبوطاً (بلا رقم لا محادثة تُفتح، وزرٌّ يقود إلى لا شيء أسوأ من غيابه).
   *
   * الاستثناء على الرقم يُحترم أيضاً: من وُضع له استثناء بـEMAIL يُرسَل
   * إليه بريداً ولا معنى لمطالبته بفتح واتساب.
   */
  /**
   * رقم البوابة الصالح، أو `null` إن غاب أو كان ناقصاً.
   *
   * **يُتحقَّق من طوله لا من وجوده فقط.** ضُبط مرة بـ«+962» وحدها — رمز
   * الدولة بلا رقم — فمرّ فحصَ الوجود وبُني منه `wa.me/962`، فيفتح واتساب
   * على «لا حساب لهذا الرقم» بلا ما يدلّ على الخطأ. رقمٌ ناقص هنا كغيابه
   * تماماً: كلاهما لا يُفتح به محادثة.
   *
   * القاعدة أولاً ثم متغيّر البيئة: القيمة صارت تُضبط من اللوحة، ويبقى
   * المتغيّر بديلاً لمن لم يضبطها بعد فلا ينكسر ما كان يعمل.
   */
  private async gatewayNumber(): Promise<string | null> {
    const row = await this.prisma.otpChannelSettings.findUnique({
      where: { id: 1 },
      select: { waGatewayNumber: true },
    });
    const raw = (
      row?.waGatewayNumber ??
      process.env.WHATSAPP_GATEWAY_NUMBER ??
      ''
    ).trim();
    if (!raw) return null;
    // نفس مطبِّع أرقام الزبائن: عدّ الخانات وحده يقبل «+9620770600234» —
    // صفراً محلياً بقي بعد رمز الدولة — فيبني رابطاً لرقم لا وجود له. وقيمة
    // قديمة محفوظة بصيغة خاطئة تُردّ هنا أيضاً لا عند الحفظ وحده.
    return toJordanE164(raw);
  }

  async whatsappHandshakeAvailability(rawPhone?: string) {
    const gatewayNumber = await this.gatewayNumber();
    if (!gatewayNumber) return { available: false };

    let channel: string;
    if (rawPhone) {
      try {
        const resolved = await this.otpDelivery.resolveFor(
          normalizeJordanPhone(rawPhone),
        );
        channel = resolved.channel;
      } catch {
        channel = await this.otpDelivery.currentChannel();
      }
    } else {
      channel = await this.otpDelivery.currentChannel();
    }

    return { available: channel === 'OPENWA' };
  }

  /**
   * **الخطوة الأولى من مصافحة واتساب**: يفتح جلسة تحقق ويُرجع ما يحتاجه
   * التطبيق ليفتح محادثة الرقم الرسمي برسالة مُملوءة مسبقاً.
   *
   * **لماذا يرسل المستخدمُ أولاً.** إرسالنا نحن رمزاً إلى رقم لم يراسلنا
   * يستهلك رصيد البوابة على كل محاولة، ويصطدم بقيود المراسلة الأولى. حين
   * يبدأ هو تُفتح نافذة المحادثة، ويثبت في اللحظة نفسها أنه يملك الرقم —
   * فامتلاك الرقم يصير مُثبتاً بفعله لا بما نرسله إليه.
   *
   * **والرمز في نصّ الرسالة هو ما يربطها بجلسته.** بلا رمز تكون المطابقة
   * بالرقم وحده: من راسل الرقم الرسمي لأي غرض تُحتسب رسالته تحقّقاً لأي
   * جلسة فُتحت بنفس رقمه — ومن يعرف رقم غيره يفتح جلسة به وينتظر أن يراسلنا
   * صاحبه لسببٍ آخر فتُقيَّد له. الرمز يجعل الرسالة تخصّ هذه الجلسة وحدها.
   *
   * **جلسة واحدة لكل رقم**: من ضغط الزر مرتين يستعيد رمزه الأول لا رمزاً
   * ثانياً — وإلا صارت الرسالة التي أرسلها للتوّ تحمل رمزاً أُبطل قبل أن
   * تصل، فيفشل تحقّقٌ صحيح.
   */
  async startWhatsappHandshake(rawPhone: string, ip: string | undefined) {
    const phone = normalizeJordanPhone(rawPhone);
    await this.assertNotFlooded(
      'wa-handshake-start',
      phone,
      WHATSAPP_OTP_REQUEST_MAX,
      WHATSAPP_OTP_REQUEST_WINDOW_SECONDS,
    );
    await this.assertIpNotFlooded('wa-handshake-start', ip);

    // نفس شرطَي العرض يُفحصان هنا أيضاً: التطبيق قد يكون نسخة قديمة، أو
    // بدّل الأدمن القناة بين بناء الشاشة وضغط الزر. الواجهة تُخفي، والخادم
    // يمنع — ولا يُكتفى بالأولى.
    const gatewayNumber = await this.gatewayNumber();
    const { available } = await this.whatsappHandshakeAvailability(phone);
    if (!gatewayNumber || !available) {
      throw new BadRequestException(
        'التحقق عبر واتساب غير متاح حالياً — استخدم طريقة أخرى',
      );
    }

    // جلسة قائمة لهذا الرقم؟ نُعيدها كما هي بما بقي من عمرها.
    const existing = await this.redis.get(this.waHandshakePhoneKey(phone));
    if (existing) {
      const ttl = await this.redis.ttl(this.waHandshakeKey(existing));
      if (ttl > 0) {
        return this.handshakePayload(phone, existing, gatewayNumber, ttl);
      }
    }

    const token = this.newHandshakeToken();
    // الجلسة صفٌّ واحد بمفتاحين: الرمز ← الحالة، والرقم ← الرمز. كلاهما
    // بنفس العمر فلا يبقى أحدهما يشير إلى ما انقضى.
    await this.redis.set(
      this.waHandshakeKey(token),
      JSON.stringify({ phone, confirmed: false }),
      'EX',
      WA_HANDSHAKE_TTL_SECONDS,
    );
    await this.redis.set(
      this.waHandshakePhoneKey(phone),
      token,
      'EX',
      WA_HANDSHAKE_TTL_SECONDS,
    );

    return this.handshakePayload(
      phone,
      token,
      gatewayNumber,
      WA_HANDSHAKE_TTL_SECONDS,
    );
  }

  /**
   * ما يبنيه التطبيق منه رابطَ واتساب. النصّ يُبنى هنا لا هناك: هو نفسه ما
   * يُطابَق عند الورود، وبناؤه في طرفين يعني أن تعديل أحدهما يكسر التطابق
   * بلا أن يُنبّه شيء.
   */
  private handshakePayload(
    phone: string,
    token: string,
    gatewayNumber: string,
    expiresInSeconds: number,
  ) {
    const message = `${WA_HANDSHAKE_PREFIX} ${token}`;
    const digits = gatewayNumber.replace(/[^0-9]/g, '');
    return {
      phone,
      token,
      gatewayNumber,
      message,
      // الرابط جاهزاً لا مركَّباً في التطبيق: الترميز مصدر أخطاء صامتة
      // (مسافة أو محرف عربي بلا ترميز يقطع النصّ المملوء).
      waLink: `https://wa.me/${digits}?text=${encodeURIComponent(message)}`,
      expiresInSeconds,
    };
  }

  /**
   * **الخطوة الثانية**: تُنادى من مستقبِل أحداث البوابة عند كل رسالة واردة.
   *
   * تُرجع `false` بهدوء لكل ما ليس مصافحة — الرسائل الواردة على الرقم الرسمي
   * أكثرها ردود زبائن وحملات، ولا يجوز أن يضجّ سجلّ الأخطاء بها.
   *
   * **يُشترط تطابق رقم المرسِل مع رقم الجلسة.** الرمز قد يُقرأ من فوق كتف
   * صاحبه أو يُعاد توجيه الرسالة؛ ما لا يمكن تزويره هو الرقم الذي أرسل
   * فعلاً. الرمز يحدّد الجلسة، والرقم يثبت أنها لصاحبها — ولا يكفي أحدهما.
   */
  async confirmWhatsappHandshake(
    fromPhone: string,
    body: string,
  ): Promise<boolean> {
    const token = extractHandshakeToken(body);
    if (!token) return false;

    const key = this.waHandshakeKey(token);
    const raw = await this.redis.get(key);
    if (!raw) return false; // رمز منتهٍ أو لا وجود له

    let session: { phone: string; confirmed: boolean };
    try {
      session = JSON.parse(raw);
    } catch {
      return false;
    }

    // رقم لا يطابق الجلسة: رمزٌ وصل من غير صاحبه. لا نُبطل الجلسة —
    // إبطالها يعني أن غريباً يستطيع إسقاط تحقّق غيره بإرسال رمزه.
    let normalized: string;
    try {
      normalized = normalizeJordanPhone(fromPhone);
    } catch {
      return false; // رقم غير أردني — ليس صاحب جلسة عندنا بحال
    }
    if (normalized !== session.phone) {
      this.logger.warn(
        `مصافحة واتساب: الرمز ${token} وصل من رقم لا يطابق جلسته`,
      );
      return false;
    }

    if (session.confirmed) return true; // الرسالة نفسها وصلت مرتين

    const ttl = await this.redis.ttl(key);
    await this.redis.set(
      key,
      JSON.stringify({ ...session, confirmed: true }),
      'EX',
      ttl > 0 ? ttl : WA_HANDSHAKE_TTL_SECONDS,
    );
    this.logger.log(`مصافحة واتساب اكتملت للرقم ${session.phone}`);
    return true;
  }

  /**
   * **الخطوة الثالثة**: التطبيق يستطلع هذه حتى تصل رسالة المستخدم، وعندها
   * يُرسَل رمز التحقق القصير.
   *
   * **الرمز يُرسَل من هنا لا من مستقبِل الأحداث.** المستقبِل يخدم البوابة
   * ويجب أن يردّ سريعاً، والإرسال عبر الشبكة قد يتأخّر أو يفشل فيدفع البوابة
   * إلى إعادة المحاولة فيتضاعف الإرسال. وهنا نعرف أن التطبيق ما زال مفتوحاً
   * ينتظر — فلا يُرسَل رمز إلى من أغلق التطبيق وانصرف.
   *
   * الإرسال مرة واحدة لكل جلسة: `otpSent` يمنع أن يُنتج كلُّ استطلاع رمزاً
   * جديداً يُبطل سابقه، وهو ما كان سيجعل الرمز الذي يقرأه المستخدم منتهياً
   * قبل أن يكتبه.
   */
  async pollWhatsappHandshake(rawPhone: string) {
    const phone = normalizeJordanPhone(rawPhone);
    const token = await this.redis.get(this.waHandshakePhoneKey(phone));
    if (!token) return { confirmed: false, expired: true };

    const key = this.waHandshakeKey(token);
    const raw = await this.redis.get(key);
    if (!raw) return { confirmed: false, expired: true };

    const session = JSON.parse(raw) as {
      phone: string;
      confirmed: boolean;
      otpSent?: boolean;
    };
    if (!session.confirmed) return { confirmed: false, expired: false };
    if (session.otpSent) return { confirmed: true, expired: false };

    // أول استطلاع بعد وصول الرسالة: نولّد الرمز ونُرسله.
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.redis.set(
      this.whatsappOtpKey(phone),
      code,
      'EX',
      WHATSAPP_OTP_TTL_SECONDS,
    );
    // يُعلَّم قبل الإرسال لا بعده: فشل الإرسال يبقي الرمز صالحاً في Redis،
    // وإعادة توليده مع كل استطلاع كانت ستُبطل رمزاً ربما وصل فعلاً.
    const ttl = await this.redis.ttl(key);
    await this.redis.set(
      key,
      JSON.stringify({ ...session, otpSent: true }),
      'EX',
      ttl > 0 ? ttl : WA_HANDSHAKE_TTL_SECONDS,
    );
    await this.otpDelivery.sendOtp(phone, code, WHATSAPP_OTP_TTL_SECONDS / 60);

    const isRegistered =
      (await this.prisma.user.count({ where: { phone } })) > 0;
    return {
      confirmed: true,
      expired: false,
      isRegistered,
      message: 'تم إرسال رمز التحقق عبر واتساب',
      ...(this.whatsapp.isRealProvider ? {} : { devCode: code }),
    };
  }

  /** تحقق رمز الواتساب ثم نفس مسار الدخول المشترك (loginByPhone) بالضبط */
  async verifyWhatsappOtp(
    rawPhone: string,
    code: string,
    name: string | undefined,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    const phone = normalizeJordanPhone(rawPhone);
    await this.assertNotFlooded(
      'whatsapp-otp-verify',
      phone,
      WHATSAPP_OTP_VERIFY_MAX,
      WHATSAPP_OTP_VERIFY_WINDOW_SECONDS,
    );

    // حساب مراجعة المتجر: رقم التطبيق يمرّ بلا واتساب — بالرمز المحفوظ أو
    // بلا رمز إن قرر الأدمن ذلك (ReviewAccountService). لا يسبق حدّ
    // المحاولات فوقه: من يخمّن على هذا الرقم يُقيَّد مثل غيره بالضبط.
    if (await this.reviewAccount.isReviewLogin(phone, code)) {
      return this.loginByPhone(phone, name, deviceInfo, ip);
    }

    const key = this.whatsappOtpKey(phone);
    const stored = await this.redis.get(key);
    if (!stored || stored !== code) {
      throw new UnauthorizedException('رمز التحقق غير صحيح أو منتهي');
    }
    await this.redis.del(key); // استخدام واحد فقط، مثل رمز OTP القديم بالضبط

    return this.loginByPhone(phone, name, deviceInfo, ip);
  }

  // حساب مراجعة المتجر انتقل إلى ReviewAccountService: كان متغيّرَي بيئة
  // (APPLE_REVIEW_PHONE/APPLE_REVIEW_OTP) برقم واحد للتطبيقين، وإغلاقه بعد
  // قبول التطبيق يتطلب لمس Railway — وهي الخطوة التي تُنسى. صار صفّاً لكل
  // تطبيق يغلقه الأدمن من اللوحة بضغطة.

  /**
   * دخول تطوير — بدون Firebase وبدون أي رمز تحقق إطلاقاً: يدخل مباشرة
   * برقم الهاتف. معطَّل تماماً بالإنتاج إلا إذا فُعِّل صراحة عبر
   * AUTH_DEV_LOGIN=1 (لبيئة staging مثلاً)، لأنه يتجاوز التحقق كلياً.
   */
  async devLogin(
    phone: string,
    name: string | undefined,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    if (!this.devLoginAllowed()) {
      throw new ForbiddenException('دخول التطوير غير متاح بهذه البيئة');
    }
    return this.loginByPhone(normalizeJordanPhone(phone), name, deviceInfo, ip);
  }

  private devLoginAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' || process.env.AUTH_DEV_LOGIN === '1';
  }

  /** المنطق المشترك بعد التحقق من الهوية — Firebase أو تطوير على حد سواء */
  private async loginByPhone(
    phone: string,
    name: string | undefined,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    let user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      // الاسم إلزامي لإنشاء حساب: البديل السابق ('عميل جديد') كان يثبّت اسماً
      // زائفاً إلى الأبد — لا شاشة بالتطبيق تعدّل الاسم بعد التسجيل. ويمنع
      // كذلك أن يخلق سائقٌ أدخل رقماً غير مسجّل حساباً شبحاً بلا أدوار.
      const trimmed = name?.trim();
      if (!trimmed) {
        throw new BadRequestException(
          'هذا الرقم غير مسجّل — أدخل الاسم لإنشاء حساب جديد',
        );
      }
      // زبون جديد — لا يُمنح أي دور تلقائياً (UserRole هو محدد النوع)
      // `phoneVerifiedAt` يُملأ هنا: الوصول إلى هذا السطر يعني أن رمزاً تحقّق
      // بالفعل (واتساب أو Firebase)، فالرقم مُثبَت لا مُدَّعى.
      user = await this.prisma.user.create({
        data: { phone, name: trimmed, phoneVerifiedAt: new Date() },
      });
    } else if (!user.phoneVerifiedAt) {
      // حساب أنشئ قبل وجود الحقل (أو أنشأته اللوحة بلا توثيق) ودخل الآن برمز
      // صحيح: نثبّت التوثيق فلا يُسأل عنه من جديد عند أول طلب.
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { phoneVerifiedAt: new Date() },
      });
    }
    return this.finishLogin(user, deviceInfo, ip);
  }

  /**
   * ما بعد إثبات الهوية، أيّاً كانت وسيلتها (جوجل، واتساب، تطوير): الفحوص
   * المشتركة ثم إصدار التوكنات. مستخرَج من `loginByPhone` حين صار لجوجل مسار
   * لا يمرّ بهاتف أصلاً — الفحوص التالية لا علاقة لها بوسيلة الدخول.
   */
  private async finishLogin(
    user: User,
    deviceInfo: string | undefined,
    ip: string | undefined,
  ) {
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('الحساب موقوف — تواصل مع الدعم');
    }
    if (await this.isDashboardAccount(user.id)) {
      throw new ForbiddenException(
        'هذا حساب لوحة تحكم — ادخل من اللوحة باسم المستخدم وكلمة المرور',
      );
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.enforceSingleDevice(user.id);
    return this.issueTokens(user.id, deviceInfo, ip, publicUser(user));
  }

  /**
   * **جهاز واحد لكل حساب**: الدخول من جهاز جديد يُخرج السابق فوراً.
   *
   * **يسري على السائقين وموظفي الوكالات وحدهم.** السائق: حساب على هاتفين
   * يعني عرضين لنفس الرجل وموقعين متضاربين يتناوبان على الخريطة. وموظف
   * الوكالة: حسابه يحمل صلاحيات تقبل الطلبات وتعيّن السائقين، وتداوله بين
   * اثنين يجعل سجل التدقيق بلا معنى.
   *
   * **الزبائن وموظفو المنصة مستثنون.** الزبون: هاتف ولوح لنفس الشخص سلوك
   * عادي، ولا صلاحية عنده تُساء. وموظف المنصة: يعمل على المكتب واللابتوب
   * بالتناوب، وطردٌ مع كل انتقال يعطّل عمله يومياً بلا أن يمنع شيئاً — من
   * يشارك حسابه يُكشف بسجل التدقيق وبشاشة «الأجهزة» التي تُخرج أيّ جلسة.
   *
   * الأثر المقصود لمن يسري عليه: من يدخل أخيراً هو من يبقى. ومن يجد نفسه
   * مطروداً مراراً يعرف أن أحداً غيره يستعمل حسابه — إشارة أمنية لا إزعاج.
   *
   * السحب فوري لا بعد انتهاء توكن الوصول: الحارس يتحقق من الجلسة (sid) مع
   * كل طلب، والسبب يُخزَّن ليُقال للجهاز المطرود بدل «جلسة غير صالحة».
   */
  private async enforceSingleDevice(userId: string): Promise<void> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { scope: true } } },
    });
    // الزبون بلا أدوار إطلاقاً: هاتفه ولوحُه حالة عادية، وطردُه من أحدهما مع
    // كل دخول إزعاجٌ بلا مقابل — لا صلاحيات عنده تُساء ولا سجل تدقيق يُلبَّس.
    if (roles.length === 0) return;
    // موظف المنصة يعمل على المكتب واللابتوب بالتناوب — راجع التوثيق أعلاه
    if (roles.some((r) => r.role.scope === 'PLATFORM')) return;
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'NEW_DEVICE' },
    });
    // إبلاغ الجهاز المطرود فوراً. السحب كان يجري في القاعدة صامتاً: لا حدث
    // ولا قطع، فيبقى التطبيق مفتوحاً أمام صاحبه يعمل ظاهرياً وتصله العروض
    // على قناته الحيّة حتى أول نداء HTTP يفشل — وقد لا يفشل قبل دقائق.
    //
    // تُستدعى قبل issueTokens، فكل جلسة حيّة الآن جلسةُ جهاز قديم بالضرورة:
    // لا خطر أن نطرد الجهاز الجديد بها.
    if (count > 0) {
      // **وتُمحى توكنات الأجهزة معها.** سحبُ الجلسة كان يترك التوكن قائماً،
      // فيبقى الجهاز المطرود يتلقّى العروض والتنبيهات وهو مسجَّل خروجاً —
      // إشعارٌ يفتحه صاحبه فيجد شاشة دخول. والجهاز الجديد يسجّل توكنه عند
      // إقلاعه فلا يفقد شيئاً.
      //
      // الحذف قبل الإبلاغ: الإبلاغ قد يفشل (لا قناة حيّة) ولا يجوز أن يمنع
      // تنظيفاً يمنع إشعارات خاطئة.
      await this.prisma.deviceToken.deleteMany({ where: { userId } });
      await this.gateway.emitSessionRevoked(
        userId,
        SESSION_REVOKED_AR.NEW_DEVICE,
      );
    }
  }

  // ============ شروط الاستخدام ============

  /**
   * تسجيل قبول المستخدم للشروط. يُستدعى مرة واحدة عند أول دخول، ويُعاد
   * استدعاؤه إن رُفعت نسخة الشروط.
   *
   * الوقت والنسخة يُخزَّنان معاً: «وافق» بلا تاريخ ولا نسخة لا تصلح دليلاً
   * إن نُوزع لاحقاً على ما التزم به ومتى.
   */
  async acceptTerms(userId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION },
    });
    return publicUser(user);
  }

  // ============ تعديل الاسم ============

  /**
   * يعدّل المستخدم اسمه بنفسه — لأن الاسم كان يُلتقط مرة واحدة عند التسجيل
   * ولا سبيل لتصحيح خطأ مطبعي بعدها.
   *
   * مقيَّد بمهلة تبريد شهرية: الاسم هو ما يراه السائق على باب الزبون وما
   * يظهر بتذاكر الدعم وسجلات الطلبات، فتغييره المتكرر يربك التتبّع ويفتح
   * باب انتحال هوية. والقيد على المسار كذلك (حدّ محاولات قصير) حتى لا
   * يتحوّل الرفض نفسه إلى حِمل استعلامات.
   */
  async updateOwnName(userId: string, rawName: string) {
    await this.assertNotFlooded(
      'name-change',
      userId,
      NAME_CHANGE_ATTEMPT_MAX,
      NAME_CHANGE_ATTEMPT_WINDOW_SECONDS,
    );

    const name = rawName.trim().replace(/\s+/g, ' ');
    if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `الاسم بين ${NAME_MIN_LENGTH} و${NAME_MAX_LENGTH} حرفاً`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الحساب غير موجود');

    // نفس الاسم ليس تعديلاً — لا يستهلك المهلة ولا يكتب سجلاً
    if (user.name === name) return this.nameChangeState(user.nameUpdatedAt, name);

    const nextAllowedAt = this.nextNameChangeAt(user.nameUpdatedAt);
    if (nextAllowedAt && nextAllowedAt > new Date()) {
      const days = Math.ceil(
        (nextAllowedAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      );
      throw new BadRequestException(
        `لا يمكن تعديل الاسم إلا مرة كل ${NAME_CHANGE_COOLDOWN_DAYS} يوماً — ` +
          `بقي ${days} ${days === 1 ? 'يوم' : 'يوماً'}`,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { name, nameUpdatedAt: new Date() },
    });
    // تغيير الاسم حدث هوية — يُسجَّل بالقيمتين ومَن غيّره
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'user.name.self_update',
        entityType: 'User',
        entityId: userId,
        oldValue: { name: user.name },
        newValue: { name },
      },
    });
    return this.nameChangeState(updated.nameUpdatedAt, updated.name);
  }

  /**
   * إقرار الاسم عند أول دخول — خطوة مستقلة عن `updateOwnName`.
   *
   * لماذا لا تُعاد استعمال دالة التعديل: الإقرار الأول ليس تعديلاً. من يدخل
   * بجوجل يجد اسمه مملوءاً باسم لم يكتبه لهذه الخدمة (قد يكون بالإنجليزية أو
   * كنية)، فتأكيده — أو تصحيحه — أول مرة يجب ألا يستهلك مهلة التبريد؛ وإلا
   * علِق شهراً كاملاً بخطأ ارتكبه في أول ثانية.
   *
   * تُستدعى مرة واحدة فعلياً: بعد ملء `nameConfirmedAt` تصير أي تسمية لاحقة
   * عبر `updateOwnName` بمهلتها الكاملة. واستدعاؤها ثانيةً لا يعيد فتح الباب.
   */
  async confirmOwnName(userId: string, rawName: string) {
    await this.assertNotFlooded(
      'name-confirm',
      userId,
      NAME_CHANGE_ATTEMPT_MAX,
      NAME_CHANGE_ATTEMPT_WINDOW_SECONDS,
    );

    const name = rawName.trim().replace(/\s+/g, ' ');
    if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `الاسم بين ${NAME_MIN_LENGTH} و${NAME_MAX_LENGTH} حرفاً`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('الحساب غير موجود');

    // أُقرّ سابقاً: هذا المسار لا يتجاوز المهلة مرتين — من أراد تعديلاً بعد
    // الإقرار يمرّ بـupdateOwnName ومهلتها، وهي المكان الذي يحرس التكرار.
    if (user.nameConfirmedAt) return this.updateOwnName(userId, name);

    const changed = user.name !== name;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name,
        nameConfirmedAt: new Date(),
        // `nameUpdatedAt` يبقى فارغاً هنا عمداً — حتى حين يصحّح الاسم.
        //
        // الإقرار الأول ليس تعديلاً مهما كتب فيه: من صحّح `Ma` إلى «محمد
        // العلي» ثم رأى حرفاً ناقصاً كان سيعلق ثلاثين يوماً بخطأ ارتكبه في
        // أول دقيقة من استعماله التطبيق — وهو ما وُجدت هذه الدالة لتمنعه.
        // فتُترك حصّته الأولى في `updateOwnName` كاملة، والمهلة تبدأ من
        // أول تعديل حقيقي بعد أن استقر على اسم.
      },
    });

    if (changed) {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'user.name.first_confirm',
          entityType: 'User',
          entityId: userId,
          oldValue: { name: user.name },
          newValue: { name },
        },
      });
    }
    return this.nameChangeState(updated.nameUpdatedAt, updated.name);
  }

  /** متى يُسمح بالتعديل التالي — null إن لم يعدّل من قبل (متاح فوراً) */
  private nextNameChangeAt(nameUpdatedAt: Date | null): Date | null {
    if (!nameUpdatedAt) return null;
    return new Date(
      nameUpdatedAt.getTime() + NAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
    );
  }

  /** التطبيق يعطّل الحقل ويعرض الموعد بلا أن يحسب المهلة بنفسه */
  private nameChangeState(nameUpdatedAt: Date | null, name: string) {
    const nextAllowedAt = this.nextNameChangeAt(nameUpdatedAt);
    const canChangeNow = !nextAllowedAt || nextAllowedAt <= new Date();
    return {
      name,
      nameUpdatedAt,
      canChangeNameAt: canChangeNow ? null : nextAllowedAt,
      cooldownDays: NAME_CHANGE_COOLDOWN_DAYS,
    };
  }

  // ============ دخول اللوحات: اسم مستخدم + كلمة مرور ============

  /** المعرّف: اسم المستخدم أو البريد — كلاهما فريد وبحروف صغيرة */
  async loginWithPassword(
    identifier: string,
    password: string,
    deviceInfo?: string,
    ip?: string,
  ) {
    const key = normalizeUsername(identifier);
    if (!key || !password) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    await this.assertNotLocked(key);

    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: key }, { email: key }] },
    });
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      const left = await this.recordFailedLogin(key);
      throw new UnauthorizedException(
        left > 0
          ? `اسم المستخدم أو كلمة المرور غير صحيحة (${left} محاولات متبقية)`
          : 'اسم المستخدم أو كلمة المرور غير صحيحة',
      );
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('الحساب موقوف — تواصل مع المدير');
    }
    await this.clearFailedLogins(key);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.enforceSingleDevice(user.id);
    return {
      ...(await this.issueTokens(user.id, deviceInfo, ip, publicUser(user))),
      mustChangePassword: user.mustChangePassword,
    };
  }

  /** تغيير كلمة المرور يلغي كل الجلسات الأخرى — الجهاز الحالي يبقى بتوكن جديد */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    deviceInfo?: string,
    ip?: string,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) {
      throw new BadRequestException('هذا الحساب لا يستخدم كلمة مرور');
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('كلمة المرور الحالية غير صحيحة');
    }
    assertValidPassword(newPassword);
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException('كلمة المرور الجديدة مطابقة للحالية');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
      },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });
    return this.issueTokens(userId, deviceInfo, ip);
  }

  // ---- حد إغراق حسب مفتاح عام (هاتف مثلاً) — نمط مطابق لـassertIpNotFlooded ----

  private async assertNotFlooded(
    scope: string,
    identifier: string,
    max: number,
    windowSeconds: number,
  ) {
    try {
      const key = `flood:${scope}:${identifier}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, windowSeconds);
      if (n > max) {
        throw new ForbiddenException('محاولات كثيرة — حاول بعد ربع ساعة');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
    }
  }

  // ---- حد إغراق حسب IP (Redis؛ فشله لا يمنع طلباً مشروعاً) ----

  private async assertIpNotFlooded(scope: string, ip: string | undefined) {
    if (!ip) return; // لا IP معروف (بيئة اختبار محلية مثلاً) — لا نقيّد بلا مفتاح
    try {
      const key = `ipflood:${scope}:${ip}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, IP_FLOOD_WINDOW_SECONDS);
      if (n > IP_FLOOD_MAX) {
        throw new ForbiddenException('محاولات كثيرة من هذا العنوان — حاول بعد ربع ساعة');
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
    }
  }

  // ---- قفل التخمين (Redis؛ فشله لا يمنع الدخول) ----

  private lockKey = (id: string) => `login:fail:${id}`;

  private async assertNotLocked(id: string) {
    try {
      const fails = Number(await this.redis.get(this.lockKey(id))) || 0;
      if (fails >= MAX_LOGIN_ATTEMPTS) {
        throw new ForbiddenException(
          'كثرة محاولات الدخول الخاطئة — حاول بعد ربع ساعة',
        );
      }
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;
    }
  }

  private async recordFailedLogin(id: string): Promise<number> {
    try {
      const fails = await this.redis.incr(this.lockKey(id));
      if (fails === 1) await this.redis.expire(this.lockKey(id), LOGIN_LOCK_SECONDS);
      return Math.max(0, MAX_LOGIN_ATTEMPTS - fails);
    } catch {
      return 0;
    }
  }

  private async clearFailedLogins(id: string) {
    try {
      await this.redis.del(this.lockKey(id));
    } catch {
      /* الكاش ليس مصدر حقيقة */
    }
  }

  private async issueTokens(
    userId: string,
    deviceInfo: string | undefined,
    ip: string | undefined,
    user?: unknown,
    /** جلسة قائمة يجري تدوير توكنها — بلا قيمة يبدأ جهاز جديد جلسته */
    existing?: { sessionId: string; startedAt: Date },
  ) {
    const sessionId = existing?.sessionId ?? randomUUID();
    const accessToken = await this.jwt.signAsync(
      { sub: userId, typ: 'v2', sid: sessionId },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        deviceInfo,
        ip,
        sessionId,
        startedAt: existing?.startedAt ?? new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return { accessToken, refreshToken, user };
  }

  /** تدوير التوكن: القديم يُلغى والجديد يحل محله — سرقة توكن مستعمل تُكتشف */
  async refresh(refreshToken: string, deviceInfo?: string, ip?: string) {
    await this.assertIpNotFlooded('refresh', ip);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // الجهاز يجدّد توكنه فيجد جلسته مسحوبة — يُقال له لماذا. ولولا ذلك
      // لظهر «جلسة منتهية» لمن أُخرج قبل دقيقة لأن أحداً دخل بحسابه.
      const reason = stored?.revokedReason
        ? SESSION_REVOKED_AR[stored.revokedReason]
        : undefined;
      throw new UnauthorizedException(reason ?? 'جلسة منتهية — سجّل الدخول مجدداً');
    }
    if (stored.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('الحساب موقوف');
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
    });
    // نفس الجهاز يواصل جلسته: التدوير لا يبدأ جلسة جديدة في شاشة الأدمن
    return this.issueTokens(stored.userId, deviceInfo, ip, undefined, {
      sessionId: stored.sessionId,
      startedAt: stored.startedAt,
    });
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
    return { ok: true };
  }

  // ============ حذف الحساب بطلب صاحبه ============

  /**
   * يحذف المستخدم حسابه بنفسه من داخل التطبيق.
   *
   * مطلب متجر لا رفاهية: قاعدة آبل 5.1.1(v) تُلزم كل تطبيق يسمح بإنشاء
   * حساب أن يسمح بحذفه من داخله — «راسِلنا لنحذفه» سبب رفض معلن.
   *
   * الحذف هنا على درجتين، لأن الحذف الكامل ليس ممكناً دائماً:
   *
   * - **حساب بلا أثر حقيقي** (لا طلبات ولا تذاكر ولا سجل تدقيق): يُمحى
   *   فعلياً بكل ما يتبعه. نفس معيار removeUserAccount في خدمة الوكالات.
   * - **حساب له تاريخ**: طلباته وفواتيره سجلّ مالي للوكالة وللمنصة لا يجوز
   *   أن يتبخّر بضغطة زر. فنُجرِّده من كل ما يدلّ على صاحبه — الاسم والرقم
   *   والصورة وربط تيليجرام والعناوين — ونوقفه. يبقى الطلب رقماً في دفتر
   *   بلا هوية خلفه، ويتحرّر الرقم لتسجيل حساب جديد نظيف.
   *
   * حالتان نرفض فيهما صراحةً بدل أن نحذف نصف حذف:
   * - **طلب جارٍ**: مندوب في الطريق وحسابٌ يختفي تحته يترك الطلب معلّقاً
   *   والوكالة بلا من تتصل به. يُلغى الطلب أو يُستلَم أولاً.
   * - **حساب سائق أو موظف**: ليس ملكاً لصاحبه وحده — عضويته في الوكالة
   *   وسجل تدقيقه يخصّان جهة أخرى. تحذفه وكالته من لوحتها.
   */
  async deleteOwnAccount(userId: string) {
    const roles = await this.prisma.userRole.count({ where: { userId } });
    if (roles > 0) {
      throw new ForbiddenException(
        'هذا الحساب تابع لوكالة — اطلب من وكالتك حذفه، لا يُحذف من هنا',
      );
    }

    const activeOrder = await this.prisma.order.count({
      where: {
        customerId: userId,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'SEARCH_FAILED'] },
      },
    });
    if (activeOrder > 0) {
      throw new BadRequestException(
        'لديك طلب جارٍ — أنهِه أو ألغِه قبل حذف الحساب',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const [orders, tickets, audits, redemptions] = await Promise.all([
        tx.order.count({ where: { OR: [{ customerId: userId }, { driverId: userId }] } }),
        tx.supportTicket.count({
          where: { OR: [{ createdByUserId: userId }, { assignedToUserId: userId }] },
        }),
        tx.auditLog.count({ where: { actorUserId: userId } }),
        tx.couponRedemption.count({ where: { customerId: userId } }),
      ]);
      const hasHistory = orders + tickets + audits + redemptions > 0;

      // ما يزول في الحالتين: كل ما يصل إلى الشخص أو يُدخله من جديد
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.notificationPreference.deleteMany({ where: { userId } });

      if (!hasHistory) {
        await tx.refreshToken.deleteMany({ where: { userId } });
        await tx.address.deleteMany({ where: { userId } });
        await tx.rateLimitViolation.updateMany({ where: { userId }, data: { userId: null } });
        await tx.user.delete({ where: { id: userId } });
        return { deleted: true };
      }

      // العنوان لا يُحذف: الطلب السابق يشير إليه (Order.addressId). يُفرَّغ
      // مما يدلّ على مكان بيت أحد، ويُخفى عن أي شاشة.
      await tx.address.updateMany({
        where: { userId },
        data: { label: 'محذوف', street: '—', building: null, floor: null, notes: null, active: false },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'ACCOUNT_DELETED' },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          // الرقم يُفرَّغ لا يُبدَّل: العمود فريد، وتركه يمنع صاحبه من
          // التسجيل من جديد بنفس رقمه — وهو حقّه.
          phone: null,
          name: 'حساب محذوف',
          username: null,
          email: null,
          passwordHash: null,
          avatarUrl: null,
          telegramChatId: null,
          status: 'DISABLED',
        },
      });
      return { deleted: false };
    });

    // الجهاز الذي ضغط الزرّ يخرج فوراً، لا عند أول نداء يفشل
    await this.gateway.emitSessionRevoked(userId, SESSION_REVOKED_AR.ACCOUNT_DELETED);
    return { ok: true, ...result };
  }
}
