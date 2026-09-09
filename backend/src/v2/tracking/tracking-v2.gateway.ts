import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { RealtimeEmitter } from './realtime.emitter';
import { estimateEta } from '../dispatch/eta.util';

/**
 * قناة المنصة الجديدة — namespace منفصل "/v2" بجانب قناة النظام القديم:
 *
 *  الغرف:
 *   - user:{id}     كل مستخدم (إشعارات وحالات طلباته)
 *   - driver:{id}   السائق (عروض التوزيع الموجهة له تحديداً)
 *   - order:{id}    متابعة طلب (الزبون يشترك بـ order:subscribe)
 *   - admin         موظفو المنصة
 *
 *  الأحداث الصادرة:
 *   - offer:new / offer:closed   (نموذج العرض بمؤقت — يستبدل القائمة المفتوحة)
 *   - order:status               تغير حالة الطلب
 *   - driver:location            موقع السائق الحي
 */
@Injectable()
@WebSocketGateway({ namespace: 'v2', cors: { origin: '*' } })
export class TrackingV2Gateway implements OnGatewayConnection {
  private readonly logger = new Logger(TrackingV2Gateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private jwt: JwtService,
    private prisma: PrismaV2Service,
    private realtime: RealtimeEmitter,
  ) {}

  /**
   * وجهة البث: الخادم المحلي على الـAPI، والباعث عبر Redis على العامل.
   * `this.server` غير معرَّف في عملية بلا HTTP — وقبل هذا الغلاف كان ذلك
   * يعني سقوط كل بثّ من العامل بصمت.
   */
  private at(rooms: string | string[]) {
    return this.realtime.to(this.server, rooms);
  }

  async handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      (client.handshake.headers.authorization?.startsWith('Bearer ')
        ? client.handshake.headers.authorization.slice(7)
        : undefined);
    if (!token) return client.disconnect(true);
    try {
      const payload = await this.jwt.verifyAsync(token);
      if (payload.typ !== 'v2') throw new Error('wrong token type');
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: { driverProfile: true, roles: { include: { role: true } } },
      });
      if (!user || user.status !== 'ACTIVE') throw new Error('inactive');
      // الجلسة قد تكون سُحبت (دخول من جهاز آخر، إخراج من الإدارة). الحارس
      // يفحص هذا مع كل طلب HTTP، والقناة لم تكن تفحصه إطلاقاً: توكن الوصول
      // يبقى صالحاً بنيوياً ربع ساعة، فالجهاز المسحوب يعيد الوصل ويستقبل
      // العروض كأن شيئاً لم يكن — وهذا ما كان يجعل «الطلب يصل» لمن طُرد.
      if (payload.sid) {
        const session = await this.prisma.refreshToken.findFirst({
          where: { sessionId: payload.sid, userId: user.id, revokedAt: null },
          select: { id: true },
        });
        if (!session) throw new Error('session revoked');
      }

      client.data.userId = user.id;
      client.data.sid = payload.sid;
      client.data.isDriver = !!user.driverProfile;
      client.join(`user:${user.id}`);
      if (user.driverProfile) client.join(`driver:${user.id}`);
      if (user.roles.some((r) => r.role.scope === 'PLATFORM')) {
        client.join('admin');
      }
      // موظفو الوكالات يتابعون طلبات وكالتهم حياً (لوحة الوكالة)
      for (const r of user.roles) {
        if (r.agencyId) client.join(`agency:${r.agencyId}`);
      }
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('order:subscribe')
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { orderId: string },
  ) {
    if (!body?.orderId || !client.data.userId) return { ok: false };
    // يشترك فقط صاحب العلاقة: الزبون أو السائق المعيَّن أو موظف منصة
    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId },
      select: { customerId: true, driverId: true },
    });
    const allowed =
      order &&
      (order.customerId === client.data.userId ||
        order.driverId === client.data.userId ||
        client.rooms.has('admin'));
    if (!allowed) return { ok: false };
    client.join(`order:${body.orderId}`);
    return { ok: true };
  }

  @SubscribeMessage('driver:location')
  async onDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { lat: number; lng: number },
  ) {
    if (!client.data.isDriver) return;
    if (typeof body?.lat !== 'number' || typeof body?.lng !== 'number') return;
    const driverId: string = client.data.userId;

    await this.prisma.driverProfile.update({
      where: { userId: driverId },
      data: { currentLat: body.lat, currentLng: body.lng, lastSeenAt: new Date() },
    });
    const activeOrders = await this.prisma.order.findMany({
      where: {
        driverId,
        status: { in: ['DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING'] },
      },
      select: {
        id: true,
        status: true,
        deliveryLat: true,
        deliveryLng: true,
        branch: { select: { lat: true, lng: true } },
      },
    });
    const payload = { driverId, lat: body.lat, lng: body.lng };
    for (const order of activeOrders) {
      // الوقت المتبقي يُحسب هنا لا في التطبيق: حسابٌ واحد يراه كل العملاء،
      // ويُستبدل بمحرك توجيه لاحقاً بلا لمس أي تطبيق مثبَّت
      const eta = estimateEta({
        status: order.status,
        deliveryLat: order.deliveryLat,
        deliveryLng: order.deliveryLng,
        driverLat: body.lat,
        driverLng: body.lng,
        branchLat: order.branch?.lat,
        branchLng: order.branch?.lng,
      });
      this.at(`order:${order.id}`).emit('driver:location', { ...payload, eta });
    }
    this.at('admin').emit('driver:location', payload);
  }

  // ============ يستدعيها المحرك وخدمة الطلبات ============
  // كلها تمرّ بـ`at()`: على الـAPI تبثّ من الخادم المحلي (والمحوّل ينشرها
  // للحاويات الأخرى)، وعلى العامل تمرّ بالباعث فوق Redis. فالمُستدعي واحد
  // في الحالين ولا يعرف أيّهما يعمل — وهذا المقصود.

  emitOfferNew(driverId: string, payload: object) {
    this.at(`driver:${driverId}`).emit('offer:new', payload);
  }

  /**
   * إخراج فوري: التطبيق يسمعه فيمسح جلسته ويعود لشاشة الدخول بالسبب.
   *
   * بلا هذا ينتظر المستخدم أول نداء شبكة ليكتشف أنه أُخرج — وقد يجلس أمام
   * شاشة تعمل ظاهرياً دقائق.
   */
  async emitSessionRevoked(
    userId: string,
    reasonAr: string,
    /** جلسة بعينها — إخراج جهاز واحد لا كل أجهزة الحساب */
    sessionId?: string,
  ) {
    // الوحيدة التي تحتاج خادماً حقيقياً لا باعثاً: `fetchSockets` تقرأ حالة
    // الوصلات وتقطعها، والباعث ينشر ولا يقرأ. ومع المحوّل تشمل النتيجة
    // وصلات الحاويات الأخرى، فيُخرَج المستخدم من كل حاوية لا من هذه وحدها.
    //
    // كل مستدعياتها مسارات HTTP (auth، agencies، platform) — لا يستدعيها
    // العامل، فغياب الخادم هناك لا يُسقط سلوكاً. ولو استُدعيت من العامل
    // يوماً فالسطر أدناه يسجّل السبب بدل أن يصمت.
    if (!this.server) {
      this.logger.warn(
        `emitSessionRevoked بلا خادم Socket.IO (ROLE=worker؟) — لم تُقطع جلسات ${userId}`,
      );
      return;
    }
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      if (sessionId && socket.data.sid !== sessionId) continue;
      socket.emit('session:revoked', { reasonAr });
      // القطع بعد مهلة قصيرة: القطع الفوري قد يُغلق الوصلة قبل أن تخرج
      // الرسالة، فيُطرد المستخدم بلا أن يعرف لماذا — وهو بالضبط ما نصلحه.
      // والقطع نفسه ضروري: تطبيقٌ قديم أو خلفيّ لا يستجيب للحدث يبقى على
      // قناة حيّة تصله العروض، وإعادة وصله ترتدّ الآن على فحص الجلسة أعلاه.
      setTimeout(() => socket.disconnect(true), 1500);
    }
  }

  emitOfferClosed(driverId: string, payload: object) {
    this.at(`driver:${driverId}`).emit('offer:closed', payload);
  }

  emitOrderStatus(
    orderId: string,
    customerId: string,
    status: string,
    noteAr?: string,
    agencyId?: string | null,
  ) {
    const payload = { orderId, status, noteAr, at: new Date().toISOString() };
    // كل الغرف في نداء واحد — socket.io يوحّد المستلمين فلا يتكرر الحدث
    this.at([
      `order:${orderId}`,
      `user:${customerId}`,
      'admin',
      ...(agencyId ? [`agency:${agencyId}`] : []),
    ]).emit('order:status', payload);
  }

  emitToAgency(agencyId: string, event: string, payload: object) {
    this.at(`agency:${agencyId}`).emit(event, payload);
  }

  /** لمستخدم بعينه — غرفة `user:{id}` يدخلها كل متصل عند المصادقة */
  emitToUser(userId: string, event: string, payload: object) {
    this.at(`user:${userId}`).emit(event, payload);
  }

  /** لمتابعي طلب بعينه — من اشترك بـ`order:subscribe` (الزبون والسائق) */
  emitToOrder(orderId: string, event: string, payload: object) {
    this.at(`order:${orderId}`).emit(event, payload);
  }

  /** لموظفي المنصة جميعاً — غرفة `admin` */
  emitToAdmins(event: string, payload: object) {
    this.at('admin').emit(event, payload);
  }
}
