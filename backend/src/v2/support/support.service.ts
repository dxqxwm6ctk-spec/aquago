import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TicketStatus } from '@prisma-v2/client';
import { normalizeJordanPhone } from '../common/phone.util';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingV2Gateway } from '../tracking/tracking-v2.gateway';
import { TelegramBotService } from './telegram-bot.service';

/** مواضيع الشكاوى المعروضة في التطبيق — القيمة تُخزَّن في SupportTicket.type */
export const COMPLAINT_TOPICS = {
  ORDER_ISSUE: 'مشكلة في طلب',
  ACCOUNT: 'مشكلة في الحساب',
  VEHICLE: 'مشكلة في المركبة',
  PAYMENT: 'مشكلة مالية',
  OTHER: 'أخرى',
} as const;

export type ComplaintTopic = keyof typeof COMPLAINT_TOPICS;

/**
 * سقف رسائل طلب التواصل قبل أن يقبله الدعم.
 *
 * البوابة كلها مبنية على حالتَي التذكرة القائمتين: `OPEN` هي الطلب بانتظار
 * الموافقة، و`IN_PROGRESS` هي الدردشة المفتوحة. ثلاث رسائل تكفي لشرح مشكلة
 * وإلحاق تفصيل نُسي، وتوقف من يرسل عشرين رسالة قبل أن يقرأها أحد.
 */
const MAX_PENDING_MESSAGES = 3;

/**
 * من أين وصلت الرسالة — يحدد **شكل** تنبيه تيليجرام لا وجوده:
 *
 *   TELEGRAM: المستخدم يراسل البوت، فالرد يعود إليه من تيليجرام. الأدمن
 *             يستقبل بطاقة كاملة بأزرارها، ويردّ بـ Reply عليها كأي بوت
 *             تواصل — وهي القناة الوحيدة التي يملك فيها الردّ من هاتفه.
 *   APP:      المستخدم يكتب داخل التطبيق وهو مسجَّل دخول، ومحادثته تُدار
 *             من لوحة المنصة. تيليجرام هنا جرسٌ لا صندوق وارد: سطر يقول
 *             «وصلت شكوى» بلا بطاقة ولا مرساة رد — لأن رداً من تيليجرام
 *             على محادثة تُدار في اللوحة يشتّت المسار بين مكانين.
 */
export type SupportChannel = 'APP' | 'TELEGRAM';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private prisma: PrismaV2Service,
    private notifications: NotificationsService,
    private bot: TelegramBotService,
    private gateway: TrackingV2Gateway,
  ) {}

  /**
   * من يتابع الشكاوى: أدوار المنصة المعنية بالدعم. بدون هذا الإشعار تبقى
   * الشكوى في صفحة لا يفتحها أحد حتى يصادف مديرٌ رؤيتها.
   */
  private async supportStaffIds(): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: {
        agencyId: null,
        role: { name: { in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'OPERATIONS'] } },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  private newCode(): string {
    return `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  /**
   * شكوى من التطبيق. النموذج المتفق عليه: المستخدم يرسل والدعم يتصل به —
   * لا محادثة داخل التطبيق. لذلك يُخزَّن النص كأول رسالة في التذكرة،
   * وتُبنى `subjectAr` لتحمل الموضوع ملخصاً حتى تُقرأ من قائمة اللوحة.
   */
  async submitComplaint(
    userId: string,
    data: { topic: ComplaintTopic; bodyAr: string; orderId?: string },
  ) {
    const body = data.bodyAr?.trim();
    if (!body || body.length < 10) {
      throw new BadRequestException('اكتب وصفاً للمشكلة (10 أحرف على الأقل)');
    }
    await this.assertNotBlocked(userId);
    if (!(data.topic in COMPLAINT_TOPICS)) {
      throw new BadRequestException('موضوع الشكوى غير صالح');
    }

    // الطلب اختياري، لكن إن أُرسل فلا يُقبل إلا إن كان للمستخدم نفسه
    let orderId: string | undefined;
    let agencyId: string | undefined;
    if (data.orderId) {
      const order = await this.prisma.order.findFirst({
        where: {
          id: data.orderId,
          OR: [{ driverId: userId }, { customerId: userId }],
        },
        select: { id: true, agencyId: true },
      });
      if (!order) throw new NotFoundException('الطلب غير موجود أو ليس لك');
      orderId = order.id;
      agencyId = order.agencyId ?? undefined;
    }

    // وكالة السائق حتى لو لم يربط الشكوى بطلب — تساعد الدعم على التوجيه
    if (!agencyId) {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { userId },
        select: { agencyId: true },
      });
      agencyId = profile?.agencyId ?? undefined;
    }

    const summary = body.length > 70 ? `${body.slice(0, 70)}…` : body;
    const ticket = await this.prisma.supportTicket.create({
      data: {
        code: this.newCode(),
        type: data.topic,
        priority: 'NORMAL',
        subjectAr: `${COMPLAINT_TOPICS[data.topic]}: ${summary}`,
        createdByUserId: userId,
        orderId,
        agencyId,
        messages: { create: { authorUserId: userId, bodyAr: body } },
      },
    });
    // نموذج الشكوى موجود في التطبيق وحده — لا مسار له من البوت
    await this.announceNewTicket(ticket.id, userId, data.topic, body, summary, 'APP');
    return { id: ticket.id, code: ticket.code, status: ticket.status };
  }

  /**
   * إشعار الدعم بتذكرة جديدة — عبر إشعارات المنصة **و**بطاقة تيليجرام.
   * مشترك بين شكاوى التطبيق وشكاوى البوت، فالوجهتان لا تفترقان مهما كان
   * مصدر الشكوى (قرار: كل الشكاوى بمكان واحد).
   */
  /**
   * جرس مختصر لأدمن تيليجرام — بلا بطاقة ولا أزرار، والأهم: **بلا تسجيل
   * مرساة رد**. فالرد بـ Reply عليه لا يُحلّ إلى تذكرة، وهذا مقصود: محادثة
   * التطبيق تُدار من لوحة المنصة، لا من صندوق وارد ثانٍ.
   */
  private async pingAdmins(text: string): Promise<void> {
    for (const chatId of this.bot.adminChatIds) {
      await this.bot.sendToChat(
        chatId,
        `${text}\n\n↩️ اقبله وردّ من لوحة المنصة › التذاكر`,
      );
    }
  }

  private async announceNewTicket(
    ticketId: string,
    userId: string,
    topic: ComplaintTopic,
    body: string,
    summary: string,
    channel: SupportChannel,
  ): Promise<void> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        createdBy: { select: { name: true, phone: true } },
        order: { select: { code: true } },
      },
    });
    if (!ticket) return;

    await this.notifications.sendMany(
      await this.supportStaffIds(),
      'COMPLAINT_RECEIVED',
      `شكوى جديدة — ${COMPLAINT_TOPICS[topic]}`,
      `${ticket.createdBy?.name ?? 'مستخدم'} (${ticket.createdBy?.phone ?? '—'}): ${summary}`,
      { ticketId: ticket.id, code: ticket.code },
    );

    // من التطبيق: جرس واحد يقول «فلان يطلب فتح دردشة»، لا أكثر. البطاقة
    // والأزرار ومرساة الرد أدوات للرد **من** تيليجرام، ولا معنى لها لمستخدم
    // يقرأ ردّنا داخل التطبيق.
    if (channel === 'APP') {
      // طلب قائم لهذا المستخدم أصلاً؟ إذاً سبق أن رنّ جرسه — نموذج الشكوى
      // القديم يفتح تذكرة مع كل إرسال، فبلا هذا الفحص يقرع الجرس مرة لكل
      // إرسال ولو كان الدعم لم يفتح الأول بعد.
      const otherOpen = await this.prisma.supportTicket.count({
        where: {
          createdByUserId: userId,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          id: { not: ticket.id },
        },
      });
      if (otherOpen > 0) return;
      await this.pingAdmins(
        `🔔 طلب فتح دردشة مع الدعم\n` +
          `${ticket.createdBy?.name ?? 'مستخدم'}` +
          `${ticket.createdBy?.phone ? ` • ${ticket.createdBy.phone}` : ''}\n` +
          `${ticket.code} — ${COMPLAINT_TOPICS[topic] ?? topic}`,
      );
      return;
    }

    const card = this.bot.ticketCard({
      code: ticket.code,
      status: ticket.status,
      topicAr: COMPLAINT_TOPICS[topic] ?? topic,
      authorName: ticket.createdBy?.name ?? 'مستخدم',
      authorPhone: ticket.createdBy?.phone ?? null,
      bodyAr: body,
      orderCode: ticket.order?.code ?? null,
    });
    const messageIds = await this.bot.sendTicketToAdmins(
      ticket.id,
      card,
      ticket.status,
    );
    if (Object.keys(messageIds).length > 0) {
      await this.prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          telegramMessageIds: messageIds,
          // البطاقة أول مرساة للرد؛ رسائل المتابعة تُضاف إليها لاحقاً
          telegramReplyIds: Object.fromEntries(
            Object.entries(messageIds).map(([chatId, id]) => [chatId, [id]]),
          ),
        },
      });
    }
  }

  /** أقصى ما نحتفظ به من مراسي الرد لكل أدمن — تذكرة طويلة لا تُراكم بلا حد */
  private static readonly maxReplyAnchors = 50;

  /**
   * يسجّل رسالةً أُرسلت لأدمن كمرساةٍ صالحة للرد على هذه التذكرة، فيصبح
   * الرد على آخر رسالة متابعة كالرد على البطاقة تماماً.
   */
  private async addReplyAnchor(
    ticketId: string,
    current: unknown,
    chatId: string,
    messageId: number,
  ): Promise<Record<string, number[]>> {
    const map = { ...((current ?? {}) as Record<string, number[]>) };
    const list = Array.isArray(map[chatId]) ? map[chatId] : [];
    map[chatId] = [...list, messageId].slice(-SupportService.maxReplyAnchors);
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { telegramReplyIds: map },
    });
    return map;
  }

  /** شكاوى المستخدم نفسه — ليتابع أنها وصلت وحالتها */
  async myComplaints(userId: string) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { createdByUserId: userId },
      include: {
        order: { select: { code: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { bodyAr: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((t) => ({
      id: t.id,
      code: t.code,
      type: t.type,
      topicAr: COMPLAINT_TOPICS[t.type as ComplaintTopic] ?? t.type,
      status: t.status,
      bodyAr: t.messages[0]?.bodyAr ?? '',
      orderCode: t.order?.code ?? null,
      createdAt: t.createdAt,
      resolvedAt: t.resolvedAt,
    }));
  }

  // ============== قناة تيليجرام ==============

  /**
   * ربط محادثة تيليجرام بحساب المنصة عبر الرقم الذي شاركه المستخدم.
   * الرقم من تيليجرام قد يأتي بلا «+» أو بصيغة محلية، فيمرّ على نفس
   * التطبيع المستخدم في تسجيل الدخول حتى يطابق ما في القاعدة.
   */
  async linkTelegramByPhone(chatId: string, rawPhone: string) {
    let phone: string;
    try {
      phone = normalizeJordanPhone(rawPhone);
    } catch {
      return { linked: false as const, reason: 'INVALID_PHONE' as const };
    }
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) return { linked: false as const, reason: 'NO_ACCOUNT' as const };

    // الرقم قد يكون مربوطاً بمحادثة أقدم (غيّر المستخدم حسابه بتيليجرام) —
    // نُفرغ الارتباط القديم أولاً لأن الحقل فريد.
    await this.prisma.user.updateMany({
      where: { telegramChatId: chatId, id: { not: user.id } },
      data: { telegramChatId: null },
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: chatId },
    });
    return { linked: true as const, name: user.name };
  }

  userByChatId(chatId: string) {
    return this.prisma.user.findUnique({ where: { telegramChatId: chatId } });
  }

  /** آخر تذكرة مفتوحة للمستخدم — رسائله التالية تُضاف إليها لا تفتح غيرها */
  private openTicketFor(userId: string) {
    return this.prisma.supportTicket.findFirst({
      where: { createdByUserId: userId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * الحظر يُفحص هنا لا في كل مدخل: `handleUserMessage` و`submitComplaint`
   * تمرّان به، وهما القناتان الوحيدتان اللتان يكتب منهما المستخدم — التطبيق
   * وتيليجرام معاً.
   */
  private async assertNotBlocked(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { supportBlockedAt: true, supportBlockReason: true },
    });
    if (!user?.supportBlockedAt) return;
    throw new ForbiddenException(
      user.supportBlockReason?.trim()
        ? `تم إيقاف مراسلتك للدعم: ${user.supportBlockReason}`
        : 'تم إيقاف مراسلتك للدعم',
    );
  }

  /** كم رسالة بقيت للمستخدم في طلب لم يُقبل بعد — null حين لا سقف */
  private async pendingRemaining(ticket: {
    id: string;
    status: TicketStatus;
    createdByUserId: string | null;
  }): Promise<number | null> {
    if (ticket.status !== 'OPEN' || !ticket.createdByUserId) return null;
    const sent = await this.prisma.ticketMessage.count({
      where: { ticketId: ticket.id, authorUserId: ticket.createdByUserId },
    });
    return Math.max(0, MAX_PENDING_MESSAGES - sent);
  }

  /**
   * قبول طلب التواصل — يفتح الدردشة بلا سقف. منفصل عن الرد عمداً: موظف قد
   * يقبل الطلب ليبدأ المستخدم بالشرح قبل أن يكون عند الموظف ما يقوله.
   */
  async acceptRequest(ticketId: string, actorUserId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('التذكرة غير موجودة');
    if (ticket.status !== 'OPEN') {
      throw new BadRequestException('الطلب ليس بانتظار الموافقة');
    }
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: 'IN_PROGRESS',
        assignedToUserId: ticket.assignedToUserId ?? actorUserId,
      },
    });
    if (ticket.createdByUserId) {
      this.gateway.emitToUser(ticket.createdByUserId, 'support:message', {
        ticketId,
        opened: true,
      });
      await this.notifications.send(
        ticket.createdByUserId,
        'COMPLAINT_REPLIED',
        `فُتحت محادثة الدعم — ${ticket.code}`,
        'قبلنا طلبك، تفضل بشرح مشكلتك ونحن معك.',
        { ticketId, code: ticket.code },
      );
    }
    await this.refreshAdminCards(ticketId);
    return { ok: true as const, code: ticket.code };
  }

  /** حظر/رفع حظر مراسلة الدعم — لا يمسّ الدخول ولا الطلب */
  async setSupportBlock(
    userId: string,
    blocked: boolean,
    reason: string | undefined,
    actorUserId: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        supportBlockedAt: blocked ? new Date() : null,
        supportBlockReason: blocked ? reason?.trim() || null : null,
      },
    });
    // محادثته القائمة تُغلق معه: حظرٌ يترك دردشة مفتوحة نصف قرار
    if (blocked) {
      await this.prisma.supportTicket.updateMany({
        where: { createdByUserId: userId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        data: { status: 'CLOSED', resolvedAt: new Date() },
      });
    }
    this.gateway.emitToUser(userId, 'support:message', { blocked });
    this.logger.warn(
      `${blocked ? 'حظر' : 'رفع حظر'} مراسلة الدعم عن ${userId} بواسطة ${actorUserId}`,
    );
    return { ok: true as const, blocked };
  }

  /**
   * رسالة واردة من مستخدم عبر البوت: تُضاف لتذكرته المفتوحة إن وُجدت،
   * وإلا تُفتح تذكرة جديدة. الموضوع OTHER لأن البوت لا يسأل عن تصنيف —
   * الدعم يصنّفها من اللوحة إن لزم.
   */
  // القناة إلزامية بلا قيمة افتراضية: مستدعٍ جديد ينسى تمريرها يجب أن يوقفه
  // المترجم، لا أن يرث سلوك القناة الأخرى بصمت
  async handleUserMessage(
    userId: string,
    text: string,
    channel: SupportChannel,
  ) {
    const body = text.trim();
    if (body.length < 10) {
      return { ok: false as const, reason: 'TOO_SHORT' as const };
    }
    await this.assertNotBlocked(userId);

    const open = await this.openTicketFor(userId);
    // طلب لم يُقبل بعد: يُسمح بشرح المشكلة وإلحاق ما نُسي، لا بإغراق الطابور
    if (open) {
      const remaining = await this.pendingRemaining(open);
      if (remaining === 0) {
        return {
          ok: false as const,
          reason: 'AWAITING_APPROVAL' as const,
          code: open.code,
        };
      }
    }
    if (open) {
      const message = await this.prisma.ticketMessage.create({
        data: { ticketId: open.id, authorUserId: userId, bodyAr: body },
      });
      await this.notifications.sendMany(
        await this.supportStaffIds(),
        'COMPLAINT_RECEIVED',
        `رسالة جديدة على ${open.code}`,
        body.length > 70 ? `${body.slice(0, 70)}…` : body,
        { ticketId: open.id, code: open.code },
      );
      this.notifyAdminsOfUserMessage(open.id, open.code, body, message.id, message.createdAt);
      if (channel === 'TELEGRAM') {
        const ids = (open.telegramMessageIds ?? {}) as Record<string, number>;
        let anchors = open.telegramReplyIds;
        for (const [chatId, cardId] of Object.entries(ids)) {
          // رداً على البطاقة: تظهر المتابعة مترابطة معها في المحادثة
          const sentId = await this.bot.sendToChat(
            chatId,
            `💬 ${open.code} — رسالة جديدة:\n\n${body}\n\nللرد: اعمل Reply على هذه الرسالة.`,
            cardId,
          );
          // تُسجَّل مرساةً حتى يعمل الرد عليها هي، لا على البطاقة الأولى وحدها
          if (sentId) anchors = await this.addReplyAnchor(open.id, anchors, chatId, sentId);
        }
      }
      // من التطبيق: **لا جرس هنا إطلاقاً**. الطلب أُبلغ عنه مرة عند فتحه،
      // وما بعده متابعةٌ عليه — سواء رسائل الطلب الثلاث قبل الموافقة أو
      // محادثةٌ قُبلت وتُدار من اللوحة. جرسٌ مع كل رسالة كان سيلاً لا تنبيهاً.
      return {
        ok: true as const,
        code: open.code,
        isNew: false as const,
        message: this.toChatMessage(message, userId),
      };
    }

    const summary = body.length > 70 ? `${body.slice(0, 70)}…` : body;
    const ticket = await this.prisma.supportTicket.create({
      data: {
        code: this.newCode(),
        type: 'OTHER',
        priority: 'NORMAL',
        subjectAr: `${COMPLAINT_TOPICS.OTHER}: ${summary}`,
        createdByUserId: userId,
        messages: { create: { authorUserId: userId, bodyAr: body } },
      },
      include: { messages: true },
    });
    await this.announceNewTicket(ticket.id, userId, 'OTHER', body, summary, channel);
    const first = ticket.messages[0];
    if (first) {
      this.notifyAdminsOfUserMessage(ticket.id, ticket.code, body, first.id, first.createdAt);
    }
    return {
      ok: true as const,
      code: ticket.code,
      isNew: true as const,
      message: first ? this.toChatMessage(first, userId) : null,
    };
  }

  /** بثّ رسالة الزبون للوحات الدعم المفتوحة الآن */
  private notifyAdminsOfUserMessage(
    ticketId: string,
    code: string,
    bodyAr: string,
    messageId: string,
    createdAt: Date,
  ): void {
    this.gateway.emitToAdmins('support:message', {
      id: messageId,
      ticketId,
      code,
      bodyAr,
      isMine: false,
      createdAt: createdAt.toISOString(),
    });
  }

  private toChatMessage(
    m: {
      id: string;
      bodyAr: string;
      authorUserId: string;
      createdAt: Date;
      agentLabel?: string | null;
    },
    viewerId: string,
    showAgentName = false,
  ) {
    return {
      id: m.id,
      bodyAr: m.bodyAr,
      /** اسم من ردّ — null حين يخفيه الإعداد أو حين تكون الرسالة من المستخدم */
      agentName: showAgentName ? m.agentLabel ?? null : null,
      isMine: m.authorUserId === viewerId,
      createdAt: m.createdAt.toISOString(),
    };
  }

  /**
   * محادثة المستخدم كاملة — رسائل **كل** تذاكره مرتّبة زمنياً، فيراها
   * متصلة كواتساب حتى لو أغلق الدعم تذكرة وفُتحت غيرها بعدها. الدعم في
   * المقابل يظل يرى تذاكر منفصلة بحالاتها في اللوحة.
   */
  async chatHistory(userId: string) {
    // desc + take: نأخذ أحدث خمسين تذكرة لا أقدمها — مع asc كان صاحب
    // التاريخ الطويل يرى محادثاته الأولى وحالةً قديمة بدل الحالية.
    const tickets = await this.prisma.supportTicket.findMany({
      where: { createdByUserId: userId },
      select: {
        id: true,
        code: true,
        status: true,
        createdAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            bodyAr: true,
            authorUserId: true,
            agentLabel: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const showAgentName = await this.showAgentName();
    const messages = tickets
      .flatMap((t) =>
        t.messages.map((m) => this.toChatMessage(m, userId, showAgentName)),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const latest = tickets[0];
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { supportBlockedAt: true, supportBlockReason: true },
    });
    const blocked = user?.supportBlockedAt != null;

    // التذكرة الحيّة قد لا تكون الأحدث إن أُغلقت وفُتح غيرها — الحالة
    // المعروضة تخصّ ما يستطيع الكتابة فيه الآن
    const live = tickets.find((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
    const remaining = live
      ? await this.pendingRemaining({ ...live, createdByUserId: userId })
      : null;

    return {
      messages,
      // حالة آخر تذكرة: الشاشة تخبر المستخدم إن كانت شكواه الأخيرة أُغلقت
      currentStatus: latest?.status ?? null,
      currentCode: latest?.code ?? null,
      blocked,
      blockReason: blocked ? user?.supportBlockReason ?? null : null,
      /** بانتظار موافقة الدعم — الدردشة لم تُفتح بعد */
      awaitingApproval: live?.status === 'OPEN',
      /** ما بقي من رسائل الطلب قبل الموافقة (null = بلا سقف) */
      pendingRemaining: remaining,
      canSend: !blocked && remaining !== 0,
      maxPendingMessages: MAX_PENDING_MESSAGES,
    };
  }

  /**
   * رد الدعم على تذكرة — مسار واحد مهما كان مصدر الرد (لوحة المنصة أو
   * تيليجرام)، حتى لا يتفرّع سلوك الرد ولا تُنسى قناةٌ عند إضافة أخرى.
   *
   * [authorUserId] هوية كاتب الرد كما تُخزَّن. من اللوحة هو الموظف نفسه؛
   * ومن تيليجرام لا حساب للأدمن (قرار المستخدم) فيُنسب للمسؤول عن التذكرة
   * أو أول موظف دعم — ولذلك يُحفظ [agentLabel] منفصلاً: هو اسم من ردّ فعلاً،
   * لا اسم الحساب الذي حُمّلت عليه الرسالة.
   *
   * النص يُخزَّن نظيفاً بلا اسم بداخله، فإظهار الاسم يصير قراراً يُبدَّل من
   * اللوحة (`showSupportAgentName`) لا حقيقةً محفورة في كل رسالة.
   */
  private async appendSupportReply(
    ticketId: string,
    text: string,
    resolveAuthor: (assignedToUserId: string | null) => Promise<string>,
    agentLabel: string,
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { createdBy: { select: { id: true, telegramChatId: true } } },
    });
    if (!ticket) throw new NotFoundException('التذكرة غير موجودة');

    const authorUserId = await resolveAuthor(ticket.assignedToUserId);
    const bodyAr = text;
    const showName = await this.showAgentName();
    // ما يُرسل خارج التطبيق (تيليجرام/إشعار) يحمل الاسم أو لا، بحسب الإعداد
    const signature = showName && agentLabel ? ` — ${agentLabel}` : '';

    const message = await this.prisma.ticketMessage.create({
      data: { ticketId, authorUserId, bodyAr, agentLabel: agentLabel || null },
    });
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: 'IN_PROGRESS',
        assignedToUserId: ticket.assignedToUserId ?? authorUserId,
      },
    });

    // الرد يصل بكل القنوات المتاحة للزبون: بثّ لحظي داخل التطبيق، وإشعار
    // (لمن أغلق التطبيق)، وتيليجرام إن كان راسلنا منه.
    if (ticket.createdByUserId) {
      this.gateway.emitToUser(ticket.createdByUserId, 'support:message', {
        id: message.id,
        ticketId,
        bodyAr,
        agentName: showName ? agentLabel || null : null,
        isMine: false,
        createdAt: message.createdAt.toISOString(),
      });
      await this.notifications.send(
        ticket.createdByUserId,
        'COMPLAINT_REPLIED',
        `رد الدعم${signature} على شكواك ${ticket.code}`,
        text,
        { ticketId, code: ticket.code },
      );
    }
    if (ticket.createdBy?.telegramChatId) {
      await this.bot.sendToChat(
        ticket.createdBy.telegramChatId,
        `💬 رد الدعم${signature} على ${ticket.code}:\n\n${text}`,
      );
    }
    await this.refreshAdminCards(ticketId);
    return { ok: true as const, code: ticket.code };
  }

  /** هل يُعرض اسم موظف الدعم للمستخدم؟ قرار المنصة من لوحتها */
  private async showAgentName(): Promise<boolean> {
    const s = await this.prisma.dispatchSettings.upsert({
      where: { id: 1 }, create: { id: 1 }, update: {},
    });
    return s.showSupportAgentName;
  }

  /** رد من تيليجرام — الأدمن بلا حساب منصة، فاسمه يأتي من ملفه هناك */
  async replyFromAdmin(ticketId: string, adminLabel: string, text: string) {
    return this.appendSupportReply(
      ticketId,
      text,
      async (assignedToUserId) => {
        const author = assignedToUserId ?? (await this.supportStaffIds())[0];
        if (!author) {
          throw new BadRequestException('لا يوجد موظف دعم لنسب الرد إليه');
        }
        return author;
      },
      adminLabel,
    );
  }

  /** رد من لوحة المنصة — الاسم من حساب الموظف نفسه */
  async replyFromDashboard(ticketId: string, actorUserId: string, text: string) {
    const body = text.trim();
    if (!body) throw new BadRequestException('اكتب نص الرد');
    const actor = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { name: true },
    });
    return this.appendSupportReply(
      ticketId,
      body,
      async () => actorUserId,
      actor?.name ?? '',
    );
  }

  /** تغيير حالة التذكرة من أزرار تيليجرام */
  async setStatusFromTelegram(
    ticketId: string,
    status: 'IN_PROGRESS' | 'CLOSED',
    adminLabel: string,
  ) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { createdBy: { select: { telegramChatId: true } } },
    });
    if (!ticket) throw new NotFoundException('التذكرة غير موجودة');

    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status,
        resolvedAt: status === 'CLOSED' ? new Date() : null,
      },
    });

    if (status === 'CLOSED') {
      if (ticket.createdBy?.telegramChatId) {
        await this.bot.sendToChat(
          ticket.createdBy.telegramChatId,
          `🔒 تم إغلاق شكواك ${ticket.code}.\n\nإن كانت المشكلة قائمة، أرسل رسالة جديدة وسنفتح لك شكوى أخرى.`,
        );
      }
      if (ticket.createdByUserId) {
        await this.notifications.send(
          ticket.createdByUserId,
          'COMPLAINT_CLOSED',
          `أُغلقت شكواك ${ticket.code}`,
          'إن كانت المشكلة قائمة، أرسل شكوى جديدة.',
          { ticketId, code: ticket.code },
        );
      }
    }
    await this.refreshAdminCards(ticketId);
    return { ok: true as const, code: ticket.code, adminLabel };
  }

  /** يُعيد رسم بطاقة التذكرة عند كل أدمن بحالتها الحالية */
  private async refreshAdminCards(ticketId: string): Promise<void> {
    const t = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        createdBy: { select: { name: true, phone: true } },
        order: { select: { code: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 1, select: { bodyAr: true } },
      },
    });
    if (!t) return;
    const ids = (t.telegramMessageIds ?? {}) as Record<string, number>;
    if (Object.keys(ids).length === 0) return;

    const card = this.bot.ticketCard({
      code: t.code,
      status: t.status,
      topicAr: COMPLAINT_TOPICS[t.type as ComplaintTopic] ?? t.type,
      authorName: t.createdBy?.name ?? 'مستخدم',
      authorPhone: t.createdBy?.phone ?? null,
      bodyAr: t.messages[0]?.bodyAr ?? '',
      orderCode: t.order?.code ?? null,
    });
    await this.bot.updateAdminCards(ids, t.id, card, t.status);
  }

  /**
   * حذف كل التذاكر وكل الرسائل نهائياً — تفريغ شامل، لا رجعة فيه.
   * الرسائل تُحذف أولاً لاحترام مفتاحها الأجنبي على التذكرة. يُفكّ حظر
   * المراسلة عن كل من كان محظوراً بسبب تذكرة (الحظر نفسه سياسة منفصلة
   * عن الدعم؛ رفعه هنا فقط لمن حُظر آلياً عبر setSupportBlock يبقى قراراً
   * إدارياً — لذلك لا نلمس supportBlockedAt هنا إطلاقاً).
   */
  async wipeAll(actorUserId: string) {
    const [messages, tickets] = await this.prisma.$transaction([
      this.prisma.ticketMessage.deleteMany({}),
      this.prisma.supportTicket.deleteMany({}),
    ]);
    this.logger.warn(
      `تفريغ كامل لتذاكر الدعم بواسطة ${actorUserId}: ${tickets.count} تذكرة، ${messages.count} رسالة`,
    );
    this.gateway.emitToAdmins('support:message', { wiped: true });
    return { ok: true as const, ticketsDeleted: tickets.count, messagesDeleted: messages.count };
  }

  /** التذكرة التي تخصّ رسالة أدمن معيّنة — لربط الـReply بتذكرته */
  async ticketByAdminMessage(chatId: string, messageId: number) {
    const rows = await this.prisma.supportTicket.findMany({
      where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
      select: { id: true, telegramMessageIds: true, telegramReplyIds: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return (
      rows.find((r) => {
        // مراسي الرد: البطاقة وكل رسائل المتابعة
        const anchors = (r.telegramReplyIds ?? {}) as Record<string, number[]>;
        if (Array.isArray(anchors[chatId]) && anchors[chatId].includes(messageId)) {
          return true;
        }
        // تذاكر أُنشئت قبل وجود مراسي الرد — البطاقة وحدها لا تزال تعمل
        const cards = (r.telegramMessageIds ?? {}) as Record<string, number>;
        return cards[chatId] === messageId;
      })?.id ?? null
    );
  }
}
