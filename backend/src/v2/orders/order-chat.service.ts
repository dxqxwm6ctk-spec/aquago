import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, DeviceApp} from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';

const MAX_LENGTH = 1000;
const HISTORY_LIMIT = 200;

/**
 * الحالات التي تسمح بالكتابة: بعد تعيين السائق وقبل انتهاء التوصيل.
 * قبلها لا يوجد طرف ثانٍ أصلاً، وبعدها انتهت العلاقة التي تبرّر المحادثة.
 */
const OPEN_STATUSES: OrderStatus[] = [
  'DRIVER_ASSIGNED',
  'PICKED_UP',
  'DELIVERING',
];

/**
 * محادثة الطلب بين الزبون والسائق.
 *
 * الحاجة عملية: «أنا عند الباب الأزرق»، «المصعد خربان اطلع درج» — تفاصيل
 * تُقال أثناء التوصيل ولا تستحق مكالمة، ويخسرها الطرفان اليوم لأن الوسيلة
 * الوحيدة بينهما هي الهاتف.
 *
 * عمرها عمر التوصيل: تُفتح بتعيين السائق وتُقفل بانتهاء الطلب. لا خيط دائم
 * بين زبون وسائق — انتهاء الطلب ينهي سبب تواصلهما، وإبقاؤه مفتوحاً يفتح
 * باب مراسلة خارج أي طلب.
 */
@Injectable()
export class OrderChatService {
  constructor(
    private prisma: PrismaV2Service,
    private gateway: TrackingV2Gateway,
    private notifications: NotificationsService,
  ) {}

  /**
   * الطرفان وحدهما يصلان للمحادثة. لا يكفي أن يكون الطلب موجوداً: سائق آخر
   * أو زبون آخر يعرف المعرّف يجب أن يُردّ، فالمحادثة تحمل عنواناً وتفاصيل
   * وصول.
   */
  private async participantOrThrow(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        status: true,
        customerId: true,
        driverId: true,
        customer: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');

    const isCustomer = order.customerId === userId;
    const isDriver = order.driverId === userId;
    if (!isCustomer && !isDriver) {
      throw new ForbiddenException('لا تملك صلاحية على محادثة هذا الطلب');
    }
    return { order, isCustomer };
  }

  /**
   * قراءة المحادثة للإشراف — للمنصة ولصاحب الوكالة صاحبة الطلب.
   *
   * **قراءة فقط، ولا مدخل للكتابة.** المحادثة تبقى بين طرفيها: رسالة تظهر
   * فجأة من طرف ثالث تربك من يقرأها ولا تعرف الواجهة كيف تنسبها. الغرض هنا
   * فضّ نزاع («قال له انتظر ولم يأتِ») لا المشاركة فيه.
   *
   * ولا `isMine` هنا: المشرف ليس طرفاً، فتُسمّى الرسائل بأصحابها صراحةً —
   * زبون أو سائق — بدل «لي/له» التي لا معنى لها لمن يقرأ من الخارج.
   *
   * التحقق من ملكية الطلب للوكالة يقع على المستدعي (مسار الوكالة يمرّ
   * بـagencyId ويقارنه هنا)، والمنصة تقرأ أي طلب بحكم دورها.
   */
  async supervisorHistory(orderId: string, opts?: { agencyId?: string }) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        status: true,
        agencyId: true,
        customer: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException('الطلب غير موجود');
    // وكالة تقرأ طلب وكالة أخرى: يُردّ بلا كشف أن الطلب موجود أصلاً
    if (opts?.agencyId && order.agencyId !== opts.agencyId) {
      throw new NotFoundException('الطلب غير موجود');
    }
    const messages = await this.prisma.orderMessage.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      take: HISTORY_LIMIT,
      select: { id: true, bodyAr: true, authorUserId: true, createdAt: true },
    });
    return {
      orderId,
      orderCode: order.code,
      status: order.status,
      customerName: order.customer?.name ?? null,
      driverName: order.driver?.name ?? null,
      messages: messages.map((m) => ({
        id: m.id,
        bodyAr: m.bodyAr,
        author: m.authorUserId === order.customer?.id
            ? 'CUSTOMER'
            : m.authorUserId === order.driver?.id
              ? 'DRIVER'
              : 'OTHER',
        authorName: m.authorUserId === order.customer?.id
            ? order.customer?.name ?? null
            : m.authorUserId === order.driver?.id
              ? order.driver?.name ?? null
              : null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** سبب الإقفال بصيغة تُعرض كما هي — الشاشة لا تترجم حالات الطلب */
  private closedReason(status: OrderStatus): string | null {
    if (OPEN_STATUSES.includes(status)) return null;
    if (status === 'COMPLETED') return 'انتهى التوصيل — أُقفلت المحادثة';
    if (status === 'CANCELLED') return 'أُلغي الطلب — أُقفلت المحادثة';
    if (status === 'SEARCH_FAILED') return 'تعذّر إيجاد سائق — لا محادثة لهذا الطلب';
    return 'المحادثة تبدأ بعد تعيين السائق';
  }

  async history(orderId: string, userId: string) {
    const { order, isCustomer } = await this.participantOrThrow(orderId, userId);
    const messages = await this.prisma.orderMessage.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      take: HISTORY_LIMIT,
      select: { id: true, bodyAr: true, authorUserId: true, createdAt: true },
    });

    const counterpart = isCustomer ? order.driver : order.customer;
    return {
      orderId,
      orderCode: order.code,
      status: order.status,
      canSend: OPEN_STATUSES.includes(order.status),
      closedReason: this.closedReason(order.status),
      // اسم الطرف الآخر لعنوان الشاشة — لا هاتف هنا، للاتصال زرّه الخاص
      counterpartName: counterpart?.name ?? null,
      messages: messages.map((m) => ({
        id: m.id,
        bodyAr: m.bodyAr,
        isMine: m.authorUserId === userId,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async send(orderId: string, userId: string, rawBody: string) {
    const { order, isCustomer } = await this.participantOrThrow(orderId, userId);

    // الإقفال يُفرض هنا لا بالواجهة وحدها: شاشة بقيت مفتوحة بعد انتهاء
    // التوصيل ستحاول الإرسال، ورسالة تصل بعد إغلاق الطلب لا مكان لها.
    if (!OPEN_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        this.closedReason(order.status) ?? 'المحادثة مقفلة',
      );
    }
    const bodyAr = rawBody.trim();
    if (!bodyAr) throw new BadRequestException('اكتب رسالة');
    if (bodyAr.length > MAX_LENGTH) {
      throw new BadRequestException(`الرسالة أطول من ${MAX_LENGTH} حرفاً`);
    }

    const message = await this.prisma.orderMessage.create({
      data: { orderId, authorUserId: userId, bodyAr },
    });

    const recipientId = isCustomer ? order.driverId : order.customerId;
    const payload = {
      id: message.id,
      orderId,
      bodyAr,
      authorUserId: userId,
      createdAt: message.createdAt.toISOString(),
    };
    // غرفة الطلب تخدم من فتح الشاشة الآن؛ وغرفة المستلم تصله وهو بشاشة
    // أخرى فتظهر عنده إشارة المحادثة بلا أن يكون مشتركاً بالطلب.
    this.gateway.emitToOrder(orderId, 'order:message', payload);
    if (recipientId) {
      this.gateway.emitToUser(recipientId, 'order:message', payload);
      const senderLabel = isCustomer ? 'الزبون' : 'السائق';
      await this.notifications.send(
        recipientId,
        'ORDER_MESSAGE',
        `رسالة من ${senderLabel} — طلب ${order.code}`,
        bodyAr.length > 120 ? `${bodyAr.slice(0, 120)}…` : bodyAr,
        { orderId, messageId: message.id },
        // المستقبِل هو الطرف الآخر: رسالةُ الزبون تذهب لتطبيق السائق
        // والعكس. ولولا ذلك لوصلت رسالة الزبون إلى تطبيق الزبون نفسه حين
        // يكون السائق والزبون حساباً واحداً.
        { app: isCustomer ? DeviceApp.DRIVER : DeviceApp.CUSTOMER },
      );
    }

    return {
      id: message.id,
      bodyAr,
      isMine: true,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
