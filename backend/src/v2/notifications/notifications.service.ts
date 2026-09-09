import { DeviceApp } from '@prisma-v2/client';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { FcmService } from './fcm.service';

/** فئات الإشعارات كما يراها المستخدم في شاشة الإعدادات */
export type NotificationCategory = 'offers' | 'orders' | 'system';

/**
 * كل نوع إشعار ينتمي لفئة واحدة. الأنواع غير المذكورة تقع في `system`
 * حتى لا يصمت إشعار جديد لمجرّد أن أحداً نسي تسجيله هنا.
 */
const CATEGORY_BY_TYPE: Record<string, NotificationCategory> = {
  OFFER_RECEIVED: 'offers',
  ORDER_ACCEPTED: 'orders',
  ORDER_CANCELLED: 'orders',
  ORDER_DRIVER_CANCELLED: 'orders',
  ORDER_NEEDS_ASSIGNMENT: 'orders',
  // مراحل التوصيل كما يعيشها الزبون: خرجت القوارير، انطلق السائق، وصل
  // إلى الباب. الأخير أهمها — يسبق تحصيل المبلغ، والزبون يحتاج أن يستعد له
  ORDER_PICKED_UP: 'orders',
  ORDER_DELIVERING: 'orders',
  ORDER_ARRIVED: 'orders',
  ORDER_COMPLETED: 'orders',
  WAITING_FOR_DRIVER: 'orders',
  NO_DRIVER_AVAILABLE: 'orders',
  SEARCH_FAILED: 'orders',
  // رسالة الطرف الآخر في محادثة الطلب — تخصّ توصيلاً جارياً، فمن أسكت
  // إشعارات النظام يجب أن تصله رغم ذلك
  ORDER_MESSAGE: 'orders',
  // ردّ الدعم على شكواك أنت — بنفس المنطق: ليس ضجيج نظام بل جواب تنتظره.
  // كان غير مصنَّف فيقع في system، فمن أطفأها لا يعرف أن أحداً ردّ عليه.
  COMPLAINT_REPLIED: 'orders',
  COMPLAINT_CLOSED: 'orders',
  // فاتورة اشتراك أو تنبيه انتهائه — شأن مالي للوكالة لا ضجيج نظام
  SUBSCRIPTION_INVOICE: 'system',
  SUBSCRIPTION_PAID: 'system',
  SUBSCRIPTION_EXPIRING: 'system',
  // استحقاق تعاقدي: انتهاء عقد أو ترخيص أو مهلة نسخة ورقية. شأن إداري
  // للوكالة لا ضجيج نظام — ومن أطفأ إشعارات النظام يفوته أن ترخيصه ينتهي.
  CONTRACT_ALERT: 'system',
  // إشعار مخصص يرسله الأدمن يدوياً من لوحة المنصة
  ADMIN_BROADCAST: 'system',
};

export function categoryOf(type: string): NotificationCategory {
  return CATEGORY_BY_TYPE[type] ?? 'system';
}

/** الافتراضي حين لا يوجد صف تفضيلات: كل شيء مفعّل */
const DEFAULT_PREF = {
  enabled: true,
  offers: true,
  orders: true,
  system: true,
};

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaV2Service,
    private fcm: FcmService,
  ) {}

  async preferences(userId: string) {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    return {
      enabled: row?.enabled ?? DEFAULT_PREF.enabled,
      offers: row?.offers ?? DEFAULT_PREF.offers,
      orders: row?.orders ?? DEFAULT_PREF.orders,
      system: row?.system ?? DEFAULT_PREF.system,
    };
  }

  async updatePreferences(
    userId: string,
    patch: Partial<typeof DEFAULT_PREF>,
  ) {
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...DEFAULT_PREF, ...patch },
      update: patch,
    });
    return {
      enabled: row.enabled,
      offers: row.offers,
      orders: row.orders,
      system: row.system,
    };
  }

  /** هل يريد هذا المستخدم إشعاراً من هذا النوع؟ */
  async wants(userId: string, type: string): Promise<boolean> {
    const pref = await this.preferences(userId);
    if (!pref.enabled) return false;
    return pref[categoryOf(type)];
  }

  /**
   * المدخل الموحّد لإنشاء إشعار.
   *
   * **التفضيل يحكم الدفع إلى الجهاز وحده، لا وجود الإشعار.** من أطفأ
   * الإشعارات طلب ألّا يُزعَج — لا أن يُحجب عنه ما حدث في حسابه. كان
   * الإسقاط كاملاً: لا صفّ في الجدول ولا شيء في «الوارد»، فالسائق الذي
   * أطفأها لا يعرف أبداً أن زبوناً كتب له عن طلب جارٍ، ولا يجد أثراً حتى
   * لو فتح شاشة الإشعارات يبحث. صار الصفّ يُكتب دائماً، ويبقى الصمت في
   * الجهاز حيث طلبه المستخدم.
   *
   * `opts.push = false` يمنع الدفع بقرار من المُرسِل لا من المستخدم —
   * لحدثين متلازمين يستحق أحدهما وحده تنبيه الشاشة المقفلة (انظر sendMany).
   */
  async send(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: Prisma.InputJsonValue,
    opts?: { push?: boolean; app?: DeviceApp },
  ) {
    const row = await this.upsertForOrder(userId, type, titleAr, bodyAr, data);
    if (opts?.push !== false && (await this.wants(userId, type))) {
      void this.fcm.sendToUser(
        userId, type, titleAr, bodyAr,
        data as Record<string, unknown>,
        opts?.app,
      );
    }
    return row;
  }

  /**
   * صفٌّ واحد لكل طلب في «الوارد» — يُحدَّث بدل أن يُضاف.
   *
   * محادثة من عشر رسائل كانت تكتب عشرة صفوف متطابقة العنوان، فتغرق اللائحة
   * ويختفي تحتها كل ما عداها: الطلب الواحد يملأ الشاشة، وطلبٌ آخر لا يُرى
   * إلا بالتمرير الطويل. والقارئ لا يريد سجلّ الرسائل هنا — المحادثة نفسها
   * تحفظها كاملة — بل أن يعرف أن في الطلب جديداً.
   *
   * فآخر ما جرى يحلّ محلّ سابقه: العنوان والنص ووقت الإنشاء تُحدَّث،
   * و`readAt` يعود فارغاً ليُحسب غير مقروء من جديد — وإلا لبقي حدثٌ جديد
   * مقروءاً لأن سابقه قُرئ.
   *
   * الطلب هو مفتاح الدمج: بلا `orderId` (إشعار عام، ردّ دعم) يبقى كل إشعار
   * صفّاً مستقلاً كما كان — لا شيء يجمعه بغيره.
   */
  private async upsertForOrder(
    userId: string,
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: Prisma.InputJsonValue,
  ) {
    const orderId =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).orderId
        : undefined;
    if (typeof orderId === 'string' && orderId) {
      const existing = await this.prisma.notification.findFirst({
        where: {
          userId,
          data: { path: ['orderId'], equals: orderId },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (existing) {
        return this.prisma.notification.update({
          where: { id: existing.id },
          data: { type, titleAr, bodyAr, data, readAt: null, createdAt: new Date() },
        });
      }
    }
    return this.prisma.notification.create({
      data: { userId, type, titleAr, bodyAr, data },
    });
  }

  /**
   * نسخة جماعية — بنفس قاعدة [send]: الصفّ يُكتب للجميع، والتفضيل يقرّر من
   * يُدفَع إلى جهازه وحده. فمن أطفأ الإشعارات يجد الخبر في «الوارد» حين
   * يفتحه، ولا يُزعَج في شاشته المقفلة.
   *
   * `opts.push = false` يمنع الدفع عن الجميع بقرار المُرسِل — لإشعار
   * "داخلي فقط" يختاره الأدمن عمداً بلا إزعاج أحد.
   */
  async sendMany(
    userIds: string[],
    type: string,
    titleAr: string,
    bodyAr: string,
    data?: Prisma.InputJsonValue,
    opts?: { push?: boolean; app?: DeviceApp },
  ) {
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return 0;
    // بنفس قاعدة [send]: صفٌّ واحد لكل طلب يُحدَّث لا يُضاف — انظر
    // upsertForOrder. createMany لا تعرف الدمج، فيمرّ كل مستلم بالمسار نفسه.
    await Promise.all(
      recipients.map((userId) =>
        this.upsertForOrder(userId, type, titleAr, bodyAr, data),
      ),
    );
    const count = recipients.length;
    if (opts?.push !== false) {
      const allowed: string[] = [];
      for (const id of recipients) {
        if (await this.wants(id, type)) allowed.push(id);
      }
      if (allowed.length > 0) {
        void this.fcm.sendToUsers(
          allowed, type, titleAr, bodyAr,
          data as Record<string, unknown>,
          opts?.app,
        );
      }
    }
    return count;
  }

  async list(userId: string, take = 50) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(take, 100),
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, unread };
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** لا يلمس إلا إشعارات صاحب الطلب — لا حاجة لفحص ملكية منفصل */
  async markRead(userId: string, id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }

  /**
   * حذف إشعار واحد من «الوارد».
   *
   * `userId` في الشرط لا في فحص منفصل: استعلامٌ واحد لا يطال إلا صفّاً
   * يملكه صاحب الجلسة، فمعرّفٌ لغيره يعود بصفر لا بحذفٍ لا يملكه.
   *
   * الحذف نهائي ولا يمسّ ما يخبر عنه: الطلب ومحادثته باقيان، وهذا سطرٌ في
   * لائحة أخبار لا مصدر للخبر.
   */
  async remove(userId: string, id: string) {
    const { count } = await this.prisma.notification.deleteMany({
      where: { id, userId },
    });
    return { deleted: count };
  }

  /** إفراغ «الوارد» كاملاً — لصاحب الجلسة وحده */
  async removeAll(userId: string) {
    const { count } = await this.prisma.notification.deleteMany({
      where: { userId },
    });
    return { deleted: count };
  }
}
