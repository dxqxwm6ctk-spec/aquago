import { DeviceApp } from '@prisma-v2/client';
import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { FirebaseAdminService } from '../firebase/firebase-admin.service';

/**
 * طبقة الإشعارات الخارجية (Push) عبر Firebase Cloud Messaging — قابلة
 * للاستبدال عبر متغيرات البيئة، بنفس فكرة SmsService:
 *
 *  - FCM_PROVIDER=dev  (الافتراضي): لا إرسال حقيقي — يُسجَّل بالـ log فقط.
 *  - FCM_PROVIDER=firebase: إرسال حقيقي عبر Admin SDK، بحساب خدمة مُمرَّر
 *    كـ base64 في FIREBASE_SERVICE_ACCOUNT_BASE64.
 *
 * الفشل بالإرسال لا يُسقط أي شيء آخر — كل شيء هنا يبتلع أخطاءه بنفسه.
 */
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);

  constructor(
    private prisma: PrismaV2Service,
    private firebaseAdmin: FirebaseAdminService,
  ) {}

  get isRealProvider(): boolean {
    return (
      process.env.FCM_PROVIDER === 'firebase' &&
      !!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    );
  }

  private toDataPayload(
    type: string,
    data?: Record<string, unknown>,
  ): Record<string, string> {
    const out: Record<string, string> = { type };
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  }

  async sendToUser(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: Record<string, unknown>,
    app?: DeviceApp,
  ): Promise<void> {
    return this.sendToUsers([userId], type, titleAr, bodyAr, data, app);
  }

  /**
   * `app` يقصر الدفع على أجهزة تطبيق بعينه.
   *
   * **يلزم لأن السائق والزبون قد يكونان حساباً واحداً**: الدخول بالرقم يُرجع
   * نفس المستخدم، فبلا هذا القيد يصل عرضُ توصيل إلى تطبيق الزبون في يد
   * الرجل نفسه، وتصل تحديثاتُ طلبه الخاص إلى تطبيق السائق.
   *
   * غيابه يعني «كل الأجهزة» — وهو الصحيح لما لا يخصّ تطبيقاً بعينه (إشعار
   * إداري، أو حساب لا يملك إلا تطبيقاً واحداً أصلاً).
   */
  async sendToUsers(
    userIds: string[],
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: Record<string, unknown>,
    app?: DeviceApp,
  ): Promise<void> {
    try {
      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId: { in: userIds }, ...(app ? { app } : {}) },
        select: { token: true, platform: true, userId: true },
      });
      if (tokens.length === 0) {
        // **صمت هنا كان يُقرأ عطلاً في الإرسال.** لا أجهزة مسجَّلة يعني أن
        // الانقطاع سابق للخادم: التطبيق لم يصل إلى POST /device-tokens.
        this.logger.warn(
          `Push (${type}): لا أجهزة مسجَّلة للمستخدمين [${userIds.join(', ')}] — لا إرسال`,
        );
        return;
      }
      const byPlatform = tokens.reduce<Record<string, number>>((acc, t) => {
        acc[t.platform] = (acc[t.platform] ?? 0) + 1;
        return acc;
      }, {});
      this.logger.log(
        `Push (${type}): ${tokens.length} جهاز ${JSON.stringify(byPlatform)}`,
      );

      if (!this.isRealProvider) {
        this.logger.log(
          `[dev] Push (${type}) إلى ${tokens.length} جهاز: ${titleAr} — ${bodyAr}`,
        );
        return;
      }

      // **شارة لكل مستخدم بعدده هو.** كانت `badge: 1` ثابتة، فتعلق الشارة
      // على «1» إلى الأبد: كل إشعار يعيد ضبطها على الرقم نفسه، ولا شيء
      // يُنزلها. الرقم الصحيح هو عدد إشعاراته غير المقروءة، وهو يختلف من
      // مستخدم لآخر — فتُقسم الإرسالة على المستخدمين بدل رسالة واحدة
      // للجميع. (الحالة الغالبة مستخدم واحد، فلا كلفة تُذكر.)
      const unreadByUser = new Map<string, number>();
      await Promise.all(
        [...new Set(tokens.map((t) => t.userId))].map(async (uid) => {
          unreadByUser.set(
            uid,
            await this.prisma.notification.count({
              where: { userId: uid, readAt: null },
            }),
          );
        }),
      );

      this.firebaseAdmin.ensureInitialized();
      const message: admin.messaging.MulticastMessage = {
        tokens: tokens.map((t) => t.token),
        notification: { title: titleAr, body: bodyAr },
        data: this.toDataPayload(type, data),
        android: {
          priority: 'high',
          notification: {
            // **عرض التوصيل على قناته.** مهلته ٤٥ ثانية، ورنّةُ إشعارٍ عادية
            // تمرّ كما يمرّ أي خبر فيضيع العرض لغيره. قناة `aquago_offers`
            // تحمل نغمة AquaGo وأولوية قصوى، فيُعرف العرض من صوته قبل النظر
            // إلى الشاشة — وهذا هو الصوت الوحيد الذي يُسمع والتطبيق مغلق،
            // لأن النغمة المتكررة يشغّلها التطبيق نفسه ولا شيء يعمل حينها.
            //
            // المعرّف يطابق ما ينشئه تطبيق السائق (PushService._offersChannelId)
            // حرفاً بحرف — قناة لا يعرفها الجهاز تسقط على الافتراضية بصوتها.
            channelId: type === 'OFFER_RECEIVED' ? 'aquago_offers' : 'aquago_default',
            ...(type === 'OFFER_RECEIVED' ? { sound: 'offer_alert_aquago' } : {}),
          },
        },
        // iOS لا يقرأ كتلة android إطلاقاً: بلا apns يصل الإشعار صامتاً بلا
        // صوت، وبأولوية عادية قد يؤجّله النظام — وهو ما لا يحتمله عرض
        // توصيل بمهلة عشرين ثانية.
        apns: {
          headers: { 'apns-priority': '10' },
          payload: {
            aps: {
              sound: 'default',
              // **بلا thread-id لا يظهر اسم التطبيق فوق المجموعة.** حين
              // تتكدّس إشعارات تطبيق واحد يرسم iOS ترويسة للمجموعة، ويضع
              // فيها اسم الخيط (thread) إن وُجد وإلا اسم التطبيق. وبلا هذا
              // الحقل لا خيط أصلاً، فيرفع iOS عنوان أحدث إشعار إلى موضع
              // الاسم — فتقرأ المجموعة «جاري تجهيز طلبك» بدل «AquaGo»، بينما
              // كل تطبيق آخر يعرض اسمه هناك.
              //
              // والتجميع بالطلب لا بالتطبيق: إشعارات طلبٍ واحد (قُبل، في
              // الطريق، وصل) تُقرأ معاً كقصة واحدة، وطلبٌ آخر يبدأ كومته.
              // وما لا يخصّ طلباً يجتمع تحت خيط عام.
              threadId: (data?.orderId as string | undefined) ?? 'aquago',
              // **بلا contentAvailable.** كان مضبوطاً هنا مع تنبيه مرئي،
              // وهو خليط متناقض: content-available يخصّ الإشعار الصامت
              // (background)، ووجوده مع alert يجعل iOS يعامل الرسالة أحياناً
              // كتحديث خلفي فيؤجّلها أو يُسقطها — خصوصاً في وضع توفير
              // الطاقة — ويناقض apns-priority: 10 لأن الصامت لا يأخذ 10.
              // التنبيه المرئي هو المطلوب هنا، فيبقى وحده.
              // الشارة تُضبط لكل مستخدم أدناه — لا قيمة ثابتة هنا.
            },
          },
        },
      };

      // دفعات لكل مستخدم على حدة — شارته تخصّه — ثم 500 توكن كحدّ لكل نداء
      const chunks: { tokens: string[]; badge: number }[] = [];
      for (const uid of new Set(tokens.map((t) => t.userId))) {
        const userTokens = tokens.filter((t) => t.userId === uid).map((t) => t.token);
        const badge = unreadByUser.get(uid) ?? 0;
        for (let i = 0; i < userTokens.length; i += 500) {
          chunks.push({ tokens: userTokens.slice(i, i + 500), badge });
        }
      }

      const staleTokens: string[] = [];
      let sent = 0;
      for (const { tokens: chunkTokens, badge } of chunks) {
        const chunk = chunkTokens;
        const res = await admin.messaging().sendEachForMulticast({
          ...message,
          tokens: chunk,
          apns: {
            ...message.apns,
            payload: {
              ...message.apns!.payload,
              aps: { ...message.apns!.payload!.aps, badge },
            },
          },
        });
        sent += res.successCount;
        res.responses.forEach((r, i) => {
          const code = (r.error as { code?: string } | undefined)?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            staleTokens.push(chunk[i]);
          } else if (r.error) {
            // **رمز الخطأ هو التشخيص كله**، وكان يضيع صامتاً:
            //   third-party-auth-error  → مفتاح APNs غير مرفوع على Firebase
            //                             أو لا يخصّ هذا الـTeam/Bundle ID
            //   mismatched-credential   → التوكن من مشروع Firebase آخر
            //   invalid-apns-credential → المفتاح مرفوع لكنه مرفوض
            //   unregistered            → التطبيق مُزال أو التوكن منتهٍ
            this.logger.error(
              `Push (${type}) فشل لجهاز: ${code ?? 'بلا رمز'} — ${r.error.message}`,
            );
          }
        });
      }
      this.logger.log(
        `Push (${type}): نجح ${sent}/${tokens.length}` +
          (staleTokens.length ? `، حُذف ${staleTokens.length} توكن منتهٍ` : ''),
      );

      if (staleTokens.length) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: staleTokens } },
        });
      }
    } catch (err) {
      // الأثر كاملاً لا الرسالة وحدها: فشل تهيئة Admin SDK (حساب خدمة ناقص
      // أو مفتاح خاص لم يُفكّ ترميزه) يظهر برسالة عامة لا تدل على موضعه.
      this.logger.error(
        `فشل إرسال Push (${type}): ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
