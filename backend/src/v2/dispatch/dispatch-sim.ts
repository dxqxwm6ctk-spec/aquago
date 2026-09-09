/**
 * محاكي محرك التوزيع — يختبر الخدمة معزولة (بلا HTTP ولا WebSocket):
 *   S1 المسار السعيد: وكالة → عرض → قبول → DRIVER_ASSIGNED + عمولة مثبتة
 *   S2 تجاهل السائق: انتهاء مهلة → EXPIRED → عرض لسائق آخر
 *   S3 رفض شامل: استنفاد سائقي الوكالتين → SEARCH_FAILED + تذكرة Operations
 *   S4 رصيد صفر: الوكالة تُستبعد بـ AGENCY_SKIPPED
 *   S5 سباق القبول: قبولان متوازيان → واحد فقط ينجح
 *   S6 خارج التغطية: إنشاء الطلب يُرفض من الأساس
 *   S7 كل السائقين مشغولون: انتظار بدل الرفض
 *   S8 سائق يفرغ: الطلب يخرج من الانتظار تلقائياً
 *   S9 وكالة أبعد بسائق تسبق وكالة أقرب بلا سائق
 *   S10 إلغاء الزبون: مسموح حتى استلام السائق، مرفوض بعد انطلاقه إليه
 *   S11 انقضاء سقف الانتظار: إلغاء تلقائي + اعتذار + تذكرة
 *   S12 انسحاب السائق بعد القبول: بحث تلقائي عن بديل + تذكرة + عودته متاحاً
 *   S13 جولات الإعادة: من لم يردّ يُعرض عليه ثانيةً، ومن رفض لا يُعاد عليه
 *   S14 عدالة الطابور: ثلاثة منتظرين وسائق واحد يفرغ → الأقدم يسبق
 *   S15 السعة: أربعة منتظرين وسائقان يفرغان → اثنان يخرجان واثنان ينتظران
 *   S16 انسحاب لسبب يخصّ الزبون: يُسأل قبل إرسال بديل — نعم/لا/انقضاء المهلة
 *
 * تشغيل: npm run v2:sim   (يتطلب docker compose up: قاعدة v2 + Redis)
 */
import { NestFactory } from '@nestjs/core';
import { OrderStatus } from '@prisma-v2/client';
import type Redis from 'ioredis';
import { AppModule } from '../../app.module';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { REDIS } from '../redis/redis.module';
import { DispatchService } from './dispatch.service';
import { OrdersV2Service } from '../orders/orders-v2.service';

const SIM_TIMEOUT_SECONDS = 2;
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaV2Service);
  const dispatch = app.get(DispatchService);
  const orders = app.get(OrdersV2Service);
  const redis = app.get<Redis>(REDIS);

  // ============ تجهيز الحلبة ============
  await prisma.dispatchSettings.upsert({
    where: { id: 1 },
    create: { id: 1, offerTimeoutSeconds: SIM_TIMEOUT_SECONDS },
    update: { offerTimeoutSeconds: SIM_TIMEOUT_SECONDS },
  });

  const agencyA = await prisma.agency.findFirstOrThrow({
    where: { nameAr: 'وكالة مياه الوحدات' },
    include: { branches: true },
  });
  // لا حاجة لفرض دوام كامل: المحرك لم يعد يغلق الوكالات بجدول
  const types = await prisma.waterBottleType.findMany({ where: { active: true } });

  // وكالة B كاملة التجهيز (idempotent)
  let agencyB = await prisma.agency.findFirst({
    where: { nameAr: 'وكالة مياه الشمال' },
    include: { branches: true },
  });
  if (!agencyB) {
    agencyB = await prisma.agency.create({
      data: {
        nameAr: 'وكالة مياه الشمال',
        phone: '+96265555555',
        cityId: agencyA.cityId,
        status: 'ACTIVE',
        branches: {
          create: {
            nameAr: 'مستودع صويلح', lat: 32.0093, lng: 35.8442,
            deliveryRadiusKm: 12, isMain: true,
          },
        },
      },
      include: { branches: true },
    });
  }
  const branchB = agencyB.branches[0];
  // المحاكي يختبر المسار التلقائي — التعيين اليدوي له اختباره الخاص (e2e-agency)
  await prisma.agency.update({
    where: { id: agencyB.id },
    data: { status: 'ACTIVE', autoDispatch: true },
  });
  // التغطية بالنطاق: نضمن أن فرعي المحاكاة يصلان نقاط الاختبار في عمّان
  await prisma.agencyBranch.update({
    where: { id: branchB.id },
    data: { deliveryRadiusKm: 12 },
  });
  await prisma.agencyBranch.updateMany({
    where: { agencyId: agencyA.id },
    data: { deliveryRadiusKm: 12 },
  });
  // البذرة تضبطها تلقائية، لكن تجربة يدوية على اللوحة قد تكون أطفأتها —
  // وبلا Auto Dispatch ينتظر الطلب موظفاً فلا يصل أي عرض ويسقط S1 بلا سبب بيّن
  await prisma.agency.update({
    where: { id: agencyA.id },
    data: { status: 'ACTIVE', autoDispatch: true },
  });
  for (const t of types) {
    await prisma.agencyBottleAvailability.upsert({
      where: { agencyId_bottleTypeId: { agencyId: agencyB.id, bottleTypeId: t.id } },
      create: { agencyId: agencyB.id, bottleTypeId: t.id, available: true },
      update: { available: true },
    });
  }
  let walletB = await prisma.wallet.findUnique({ where: { agencyId: agencyB.id } });
  if (!walletB) {
    walletB = await prisma.wallet.create({ data: { agencyId: agencyB.id, balance: 50 } });
    await prisma.ledgerEntry.create({
      data: { walletId: walletB.id, type: 'TOPUP', amount: 50, balanceAfter: 50, noteAr: 'شحن sim' },
    });
  } else {
    await prisma.wallet.update({ where: { id: walletB.id }, data: { balance: 50 } });
  }
  for (const d of [
    { phone: '+962790000021', name: 'فراس عودة' },
    { phone: '+962790000022', name: 'منير حداد' },
  ]) {
    const u = await prisma.user.upsert({ where: { phone: d.phone }, create: d, update: {} });
    await prisma.driverProfile.upsert({
      where: { userId: u.id },
      create: {
        userId: u.id, agencyId: agencyB.id, branchId: branchB.id,
        isVerified: true, status: 'AVAILABLE', currentLat: branchB.lat, currentLng: branchB.lng,
      },
      update: { status: 'AVAILABLE' },
    });
  }

  const customer = await prisma.user.findUniqueOrThrow({ where: { phone: '+962791111111' } });
  // عنوان مخصص للمحاكاة بين مستودعي A و B: عناوين الزبون الحقيقية تتغير مع
  // كل تجربة يدوية، وكان اعتمادها يجعل تغطية الوكالتين مسألة حظ.
  //
  // النقطة هي منتصف المسافة بين المستودعين حرفياً (6.67كم من كلٍّ منهما،
  // داخل نطاق الـ12كم المفروض أدناه). الإحداثيات السابقة كانت ملاصقة
  // لمستودع B و13.89كم عن A، أي خارج نطاقه — فكانت وكالة واحدة تغطي
  // العنوان لا اثنتان، وكل سيناريو يفترض وكالتين يسقط.
  const SIM_ADDRESS = { label: 'عنوان المحاكاة', lat: 31.9959, lng: 35.9131 };
  const existing = await prisma.address.findFirst({
    where: { userId: customer.id, label: SIM_ADDRESS.label },
  });
  const address = existing
    ? await prisma.address.update({
        where: { id: existing.id },
        data: { lat: SIM_ADDRESS.lat, lng: SIM_ADDRESS.lng },
      })
    : await prisma.address.create({
        data: {
          userId: customer.id,
          label: SIM_ADDRESS.label,
          street: 'شارع المحاكاة',
          lat: SIM_ADDRESS.lat,
          lng: SIM_ADDRESS.lng,
        },
      });
  // طلبات معلّقة من تشغيل سابق تسبق طلبات هذا التشغيل في طابور FIFO فتلتقط
  // أول سائق يفرغ — تُنظَّف قبل البدء
  await prisma.order.updateMany({
    where: {
      customerId: customer.id,
      status: { in: ['CREATED', 'SEARCHING', 'WAITING_FOR_DRIVER'] },
    },
    data: { status: 'CANCELLED', cancelReason: 'sim: تنظيف الحلبة' },
  });

  const covering = await dispatch.branchesInRange(address.lat, address.lng);
  const coveringAgencies = new Set(covering.map((b) => b.agencyId));
  check(
    'الحلبة: الوكالتان A و B تغطيان عنوان المحاكاة',
    coveringAgencies.has(agencyA.id) && coveringAgencies.has(agencyB.id),
    `${coveringAgencies.size} وكالة في النطاق`,
  );

  const resetDrivers = () =>
    prisma.driverProfile.updateMany({
      where: { agencyId: { in: [agencyA.id, agencyB!.id] } },
      data: { status: 'AVAILABLE' },
    });

  /**
   * إفراغ ساحة الزبون قبل كل طلب جديد. المنصة تسمح بطلب فعّال واحد لكل زبون
   * (قرار 2026-08-09)، والسيناريوهات تترك طلبها قائماً عمداً لتفحص ما بعده —
   * فبلا هذا الإسقاط ينهار كل سيناريو تالٍ عند الإنشاء لا عند ما يختبره.
   *
   * إسقاط مباشر على القاعدة لأنه تنظيف حلبة لا مسار عمل، ولا يلمس حالة
   * السائقين: كل سيناريو يضبطها بنفسه قبل أن يبدأ.
   */
  const releaseCustomerOrders = () =>
    prisma.order.updateMany({
      where: {
        customerId: customer.id,
        status: {
          in: [
            'CREATED', 'SEARCHING', 'WAITING_FOR_DRIVER', 'AGENCY_ASSIGNED',
            'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING',
          ],
        },
      },
      data: { status: 'CANCELLED', cancelReason: 'sim cleanup' },
    });

  /**
   * سقف الإنشاء (5 طلبات / 10 دقائق) موجّه لزبون حقيقي ينقر، لا لمحاكٍ يبني
   * أربعة عشر طلباً في دقيقة. بلا مسحه يموت المحاكي عند السادس بخطأ لا علاقة
   * له بما يفحصه — والمفتاح يعيش عشر دقائق فيسمّم التشغيل التالي أيضاً.
   */
  const clearCreateQuota = () => redis.del(`order:create:${customer.id}`);

  /**
   * ما يسبق كل إنشاء. لازم لأي استدعاء لـ`orders.create` ولو خارج
   * `newOrderKeepDrivers`: الخدمة تفحص الطلب النشط والسقف **قبل** التغطية،
   * فسيناريو يختبر رفض عنوان خارج التغطية كان يُرفض لسبب آخر تماماً ويقرأ
   * الفحص ذلك فشلاً.
   */
  const prepareCreate = async () => {
    await releaseCustomerOrders();
    await clearCreateQuota();
  };

  /** طلب بحالة سائقين كما هي — لسيناريوهات الانتظار */
  const newOrderKeepDrivers = async () => {
    await prepareCreate();
    return orders.create({
      customerId: customer.id,
      addressId: address.id,
      items: [{ bottleTypeId: types[0].id, qty: 1 }],
    });
  };

  const newOrder = async () => {
    await resetDrivers();
    return newOrderKeepDrivers();
  };

  const setAllDrivers = (status: 'AVAILABLE' | 'BUSY' | 'OFFLINE') =>
    prisma.driverProfile.updateMany({
      where: { agencyId: { in: [agencyA.id, agencyB!.id] } },
      data: { status },
    });

  /** إخراج طلب انتظار من الحلبة حتى لا تستأنفه تكة لاحقة أثناء سيناريو آخر */
  const dropOrder = (orderId: string) =>
    prisma.order.updateMany({
      where: { id: orderId, status: { in: ['WAITING_FOR_DRIVER', 'SEARCHING'] } },
      data: { status: 'CANCELLED', cancelReason: 'sim cleanup' },
    });

  const pendingOffer = (orderId: string) =>
    prisma.driverOffer.findFirst({ where: { orderId, status: 'PENDING' } });

  // ============ S1: المسار السعيد ============
  console.log('\n— S1: المسار السعيد —');
  {
    const order = await newOrder();
    const flatFee = Number((await prisma.dispatchSettings.findUniqueOrThrow({ where: { id: 1 } })).commissionPerOrder);
    check('الطلب أُنشئ CREATED والعمولة مثبتة من الإنشاء', order.status === 'CREATED' && Number(order.commissionAmount) === flatFee, `${order.commissionAmount}`);
    check('الإجمالي = مياه + عمولة بلا رسوم توصيل', Number(order.total) === Math.round((Number(order.subtotal) + flatFee) * 100) / 100, `${order.subtotal} + ${flatFee} = ${order.total}`);
    await dispatch.dispatchOrder(order.id);
    const offer = await pendingOffer(order.id);
    check('وكالة اختيرت وعرض PENDING أُرسل لسائق', !!offer);
    const accepted: any = await dispatch.acceptOffer(offer!.id, offer!.driverId);
    check('القبول → DRIVER_ASSIGNED', accepted.status === 'DRIVER_ASSIGNED', `الوكالة: ${accepted.agency?.nameAr}`);
    check('العمولة لم تتغير بالقبول (snapshot من الإنشاء)', Number(accepted.commissionAmount) === flatFee, `${accepted.commissionAmount}`);
    const profile = await prisma.driverProfile.findUnique({ where: { userId: offer!.driverId } });
    check('السائق أصبح BUSY', profile?.status === 'BUSY');
    const notif = await prisma.notification.findFirst({ where: { userId: customer.id, type: 'ORDER_ACCEPTED', data: { path: ['orderId'], equals: order.id } } });
    check('الزبون وصله إشعار القبول', !!notif);
  }

  // ============ S2: تجاهل السائق → مهلة → السائق التالي ============
  console.log('\n— S2: انتهاء المهلة —');
  {
    const order = await newOrder();
    await dispatch.dispatchOrder(order.id);
    const first = await pendingOffer(order.id);
    check('عرض أول PENDING', !!first);
    await sleep((SIM_TIMEOUT_SECONDS + 3) * 1000); // ننتظر الـ Worker
    const firstAfter = await prisma.driverOffer.findUnique({ where: { id: first!.id } });
    check('العرض الأول EXPIRED عبر BullMQ', firstAfter?.status === 'EXPIRED');
    // من ترتيب العروض لا من «المعلّق الآن»: النوم يغطي أكثر من مهلة، وقد
    // تكون الجولة الثانية بدأت فيعود العرض المعلّق للسائق الأول عمداً
    const offersAsc = await prisma.driverOffer.findMany({
      where: { orderId: order.id }, orderBy: { createdAt: 'asc' },
    });
    check('عرض ثانٍ أُرسل لسائق مختلف تلقائياً',
      offersAsc.length >= 2 && offersAsc[1].driverId !== offersAsc[0].driverId);
    const second = await pendingOffer(order.id);
    const hist = await prisma.orderAssignmentHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    check('التسلسل مُسجَّل: SELECTED → SENT → EXPIRED → SENT', hist.map((h) => h.action).join(',').includes('DRIVER_OFFER_SENT,OFFER_EXPIRED,DRIVER_OFFER_SENT'));
    await dispatch.acceptOffer(second!.id, second!.driverId);
  }

  // ============ S3: رفض شامل → SEARCH_FAILED + تذكرة ============
  console.log('\n— S3: استنفاد الوكالتين —');
  {
    const order = await newOrder();
    await dispatch.dispatchOrder(order.id);
    for (let i = 0; i < 12; i++) {
      const offer = await pendingOffer(order.id);
      if (!offer) break;
      await dispatch.rejectOffer(offer.id, offer.driverId, 'sim: رفض متعمد');
    }
    const final = await prisma.order.findUnique({ where: { id: order.id } });
    check('الطلب انتهى SEARCH_FAILED (لا إلغاء تلقائي)', final?.status === 'SEARCH_FAILED');
    const hist = await prisma.orderAssignmentHistory.findMany({ where: { orderId: order.id } });
    const count = (a: string) => hist.filter((h) => h.action === a).length;
    // عدد الرفضات يتبع عدد السائقين المتاحين (يتغير ببيانات البيئة) —
    // المهم أن الوكالتين استُنفدتا برفض كل سائق مُتاح فيهما
    check('وكالتان استُنفدتا برفض كل سائق متاح', count('AGENCY_SELECTED') === 2 && count('AGENCY_FAILED') === 2 && count('DRIVER_REJECTED') >= 4, `SELECTED=${count('AGENCY_SELECTED')} REJECTED=${count('DRIVER_REJECTED')} FAILED=${count('AGENCY_FAILED')}`);
    const ticket = await prisma.supportTicket.findFirst({ where: { orderId: order.id, type: 'SEARCH_FAILED' } });
    check('تذكرة Operations فُتحت تلقائياً', !!ticket, ticket?.code);
    const notif = await prisma.notification.findFirst({ where: { userId: customer.id, type: 'SEARCH_FAILED', data: { path: ['orderId'], equals: order.id } } });
    check('الزبون أُشعر بالاعتذار والمتابعة', !!notif);
  }

  // ============ S4: رصيد صفر → استبعاد من التوزيع ============
  console.log('\n— S4: استبعاد وكالة بلا رصيد —');
  {
    await prisma.wallet.update({ where: { agencyId: agencyB.id }, data: { balance: 0 } });
    const order = await newOrder();
    await dispatch.dispatchOrder(order.id);
    const offer = await pendingOffer(order.id);
    check('الوكالة المختارة هي A (ذات الرصيد)', offer?.agencyId === agencyA.id);
    const skipped = await prisma.orderAssignmentHistory.findFirst({
      where: { orderId: order.id, action: 'AGENCY_SKIPPED', agencyId: agencyB.id },
    });
    check('وكالة B سُجِّلت AGENCY_SKIPPED بسبب الرصيد', !!skipped && skipped.reason!.includes('رصيد'));
    await dispatch.acceptOffer(offer!.id, offer!.driverId);
    await prisma.wallet.update({ where: { agencyId: agencyB.id }, data: { balance: 50 } });
  }

  // ============ S5: سباق قبول مزدوج ============
  console.log('\n— S5: سباق القبول —');
  {
    const order = await newOrder();
    await dispatch.dispatchOrder(order.id);
    const offer = await pendingOffer(order.id);
    const results = await Promise.allSettled([
      dispatch.acceptOffer(offer!.id, offer!.driverId),
      dispatch.acceptOffer(offer!.id, offer!.driverId),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled').length;
    check('قبولان متوازيان → نجاح واحد فقط (ذرّي)', wins === 1, `نجح ${wins} من 2`);
    let rejectFailed = false;
    try {
      await dispatch.rejectOffer(offer!.id, offer!.driverId);
    } catch {
      rejectFailed = true;
    }
    check('رفض عرض مقبول مرفوض', rejectFailed);
  }

  // ============ S6: خارج التغطية ============
  console.log('\n— S6: عنوان خارج التغطية —');
  {
    const far = await prisma.address.create({
      data: { userId: customer.id, label: 'العقبة', street: 'الشاطئ', lat: 29.532, lng: 35.006 },
    });
    let blocked = false;
    try {
      await prepareCreate();
      await orders.create({ customerId: customer.id, addressId: far.id, items: [{ bottleTypeId: types[0].id, qty: 1 }] });
    } catch (e: any) {
      blocked = e.message?.includes('وكالة تخدم موقعك');
    }
    check('الطلب خارج نطاق كل الوكالات يُرفض عند الإنشاء', blocked);
    await prisma.address.delete({ where: { id: far.id } });
  }

  // ============ S7: كل السائقين مشغولون → انتظار ============
  console.log('\n— S7: لا سائق متاح في أي وكالة —');
  // نافذة انتظار قصيرة نسبياً مع تكة أبعد من زمن السيناريوهات حتى لا
  // تستأنف تكةٌ طلباً بعد أن ننتقل لسيناريو آخر
  await prisma.dispatchSettings.update({
    where: { id: 1 },
    data: { maxWaitForDriverSeconds: 120, waitRetryIntervalSeconds: 60 },
  });
  let waitingOrderId = '';
  {
    await setAllDrivers('BUSY');
    const order = await newOrderKeepDrivers();
    waitingOrderId = order.id;
    await dispatch.dispatchOrder(order.id);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check('الطلب دخل WAITING_FOR_DRIVER بدل SEARCH_FAILED', after.status === 'WAITING_FOR_DRIVER', after.status);
    check('مهلة الإلغاء التلقائي مضبوطة', !!after.waitingSince && !!after.waitingUntil,
      `حتى ${after.waitingUntil?.toISOString()}`);
    check('لم يُرسل أي عرض أثناء الانتظار', !(await pendingOffer(order.id)));
    const hist = await prisma.orderAssignmentHistory.findFirst({
      where: { orderId: order.id, action: 'WAITING_STARTED' },
    });
    check('WAITING_STARTED مُسجَّل بسببه', !!hist, hist?.reason ?? '');
    const notif = await prisma.notification.findFirst({
      where: { userId: customer.id, type: 'WAITING_FOR_DRIVER', data: { path: ['orderId'], equals: order.id } },
    });
    check('الزبون أُشعر بالانتظار لا بالفشل', !!notif);
  }

  // ============ S8: سائق يفرغ → استئناف تلقائي ============
  console.log('\n— S8: أول سائق يفرغ يلتقط الطلب —');
  {
    const driver = await prisma.driverProfile.findFirstOrThrow({
      where: { agencyId: agencyA.id, isVerified: true },
    });
    await prisma.driverProfile.update({
      where: { userId: driver.userId },
      data: { status: 'AVAILABLE' },
    });
    await dispatch.onDriverAvailable(driver.userId);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: waitingOrderId } });
    check('الطلب خرج من الانتظار فور توفر سائق', after.status === 'AGENCY_ASSIGNED', after.status);
    const offer = await pendingOffer(waitingOrderId);
    check('العرض ذهب للسائق الذي أصبح متاحاً', offer?.driverId === driver.userId);
    const resumed = await prisma.orderAssignmentHistory.findFirst({
      where: { orderId: waitingOrderId, action: 'WAITING_RESUMED' },
    });
    check('WAITING_RESUMED مُسجَّل', !!resumed);
    if (offer) await dispatch.acceptOffer(offer.id, offer.driverId);
  }

  // ============ S9: الأبعد بسائق تسبق الأقرب بلا سائق ============
  console.log('\n— S9: توفر السائق يسبق القرب —');
  {
    await setAllDrivers('AVAILABLE');
    // وكالتا المحاكاة فقط — قد تغطي الموقع وكالات بيئة أخرى بلا سائقين
    const inRange = (await dispatch.branchesInRange(address.lat, address.lng)).filter(
      (b) => b.agencyId === agencyA.id || b.agencyId === agencyB!.id,
    );
    const nearest = inRange[0].agencyId;
    const farther = inRange.find((b) => b.agencyId !== nearest)?.agencyId;
    if (!farther) {
      check('السيناريو يتطلب وكالتين تغطيان الموقع', false);
    } else {
      // الأقرب بلا سائق متاح، الأبعد لديها سائق
      await prisma.driverProfile.updateMany({
        where: { agencyId: nearest },
        data: { status: 'BUSY' },
      });
      const order = await newOrderKeepDrivers();
      await dispatch.dispatchOrder(order.id);
      const offer = await pendingOffer(order.id);
      check('الطلب ذهب للوكالة الأبعد ذات السائق المتاح', offer?.agencyId === farther,
        `أقرب=${inRange[0].distanceKm.toFixed(1)}كم بلا سائق`);
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      check('لم يدخل الانتظار ما دامت وكالة واحدة تملك سائقاً', after.status === 'AGENCY_ASSIGNED');
      if (offer) await dispatch.acceptOffer(offer.id, offer.driverId);
    }
  }

  // ============ S10: إلغاء الزبون أثناء الانتظار ============
  console.log('\n— S10: إلغاء الزبون —');
  {
    await setAllDrivers('BUSY');
    const order = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(order.id);
    check('الطلب منتظر قبل الإلغاء',
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status === 'WAITING_FOR_DRIVER');
    await orders.cancelByCustomer(order.id, customer.id);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check('الإلغاء أثناء الانتظار مسموح', after.status === 'CANCELLED', after.cancelReason ?? '');

    // الحد ليس تعيين السائق بل استلامه من المستودع: ما دام لم يتحرك فعلياً
    // فلا كلفة وقعت على أحد، والإلغاء يبقى مسموحاً.
    await setAllDrivers('AVAILABLE');
    const assigned = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(assigned.id);
    const offer = await pendingOffer(assigned.id);
    check('عرض وصل لسائق', !!offer);
    await dispatch.acceptOffer(offer!.id, offer!.driverId);
    await orders.cancelByCustomer(assigned.id, customer.id);
    const afterAssigned = await prisma.order.findUniqueOrThrow({ where: { id: assigned.id } });
    check('الإلغاء بعد تعيين السائق وقبل الاستلام مسموح',
      afterAssigned.status === 'CANCELLED', afterAssigned.cancelReason ?? '');
    const freed = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: offer!.driverId } });
    check('السائق عاد متاحاً بلا أثر عليه', freed.status === 'AVAILABLE', freed.status);
    const driverNotif = await prisma.notification.findFirst({
      where: { userId: offer!.driverId, type: 'ORDER_CANCELLED', data: { path: ['orderId'], equals: assigned.id } },
    });
    check('السائق أُشعر بالإلغاء', !!driverNotif);

    // بعد الاستلام من المستودع وقبل الانطلاق: مسموح — السائق لم يتحرك نحو
    // الزبون بعد، وشاشته تقول «جاري تجهيز طلبك» لا «في الطريق إليك»
    const pickedUp = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(pickedUp.id);
    const offer2 = await pendingOffer(pickedUp.id);
    await dispatch.acceptOffer(offer2!.id, offer2!.driverId);
    await orders.driverUpdateStatus(pickedUp.id, offer2!.driverId, OrderStatus.PICKED_UP);
    await orders.cancelByCustomer(pickedUp.id, customer.id);
    check('الإلغاء بعد الاستلام وقبل الانطلاق مسموح',
      (await prisma.order.findUniqueOrThrow({ where: { id: pickedUp.id } })).status === 'CANCELLED');
    const freedAfterPickup = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: offer2!.driverId } });
    check('السائق تحرّر بعد الإلغاء', freedAfterPickup.status === 'AVAILABLE', freedAfterPickup.status);
    const returnNotif = await prisma.notification.findFirst({
      where: { userId: offer2!.driverId, type: 'ORDER_CANCELLED', data: { path: ['orderId'], equals: pickedUp.id } },
    });
    check('طُلب من السائق إعادة القوارير', !!returnNotif && returnNotif.bodyAr.includes('أعد القوارير'));

    // بعد الانطلاق يُرفض — حينها الدعم لا التطبيق
    const delivering = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(delivering.id);
    const offer3 = await pendingOffer(delivering.id);
    await dispatch.acceptOffer(offer3!.id, offer3!.driverId);
    await orders.driverUpdateStatus(delivering.id, offer3!.driverId, OrderStatus.PICKED_UP);
    await orders.driverUpdateStatus(delivering.id, offer3!.driverId, OrderStatus.DELIVERING);
    let refused = false;
    try {
      await orders.cancelByCustomer(delivering.id, customer.id);
    } catch {
      refused = true;
    }
    check('الإلغاء بعد انطلاق السائق مرفوض', refused);
    check('الطلب بقي قيد التوصيل بعد الرفض',
      (await prisma.order.findUniqueOrThrow({ where: { id: delivering.id } })).status === 'DELIVERING');
  }

  // ============ S11: انقضاء سقف الانتظار → إلغاء تلقائي ============
  console.log('\n— S11: انقضاء مهلة الانتظار —');
  {
    await prisma.dispatchSettings.update({
      where: { id: 1 },
      data: { maxWaitForDriverSeconds: 4, waitRetryIntervalSeconds: 2 },
    });
    await setAllDrivers('BUSY');
    const order = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(order.id);
    check('الطلب دخل الانتظار',
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status === 'WAITING_FOR_DRIVER');
    await sleep(8000); // ننتظر مهمة BullMQ
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check('الإلغاء التلقائي بعد المهلة', after.status === 'CANCELLED', after.cancelReason ?? '');
    const hist = await prisma.orderAssignmentHistory.findFirst({
      where: { orderId: order.id, action: 'WAITING_TIMEOUT' },
    });
    check('WAITING_TIMEOUT مُسجَّل', !!hist);
    const notif = await prisma.notification.findFirst({
      where: { userId: customer.id, type: 'ORDER_CANCELLED', data: { path: ['orderId'], equals: order.id } },
    });
    check('اعتذار للزبون بلا خصم', !!notif && notif.bodyAr.includes('لم يُخصم'));
    const ticket = await prisma.supportTicket.findFirst({
      where: { orderId: order.id, type: 'NO_DRIVER_AVAILABLE' },
    });
    check('تذكرة نقص سائقين للعمليات', !!ticket, ticket?.code);
  }

  // ============ S12: انسحاب السائق بعد القبول ============
  console.log('\n— S12: انسحاب السائق —');
  {
    await prisma.dispatchSettings.update({
      where: { id: 1 },
      data: { maxWaitForDriverSeconds: 900, waitRetryIntervalSeconds: 30 },
    });
    await setAllDrivers('AVAILABLE');
    const order = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(order.id);
    const offer = await pendingOffer(order.id);
    check('عرض وصل لسائق', !!offer);
    await dispatch.acceptOffer(offer!.id, offer!.driverId);
    const driverId = offer!.driverId;

    // بعد الاستلام: القوارير خرجت — أخطر حالات الانسحاب
    await orders.driverUpdateStatus(order.id, driverId, OrderStatus.PICKED_UP);
    await orders.cancelByDriver(order.id, driverId, 'VEHICLE_BREAKDOWN', 'المركبة تعطلت في الطريق');

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // سبب لا يخص الزبون → الطلب لا يُلغى، بل يُبحث له عن سائق آخر فوراً
    check('الطلب لم يُلغَ بل عاد للبحث', after.status !== 'CANCELLED', after.status);
    check('لا سؤال معلّق للزبون', after.redispatchAskedAt === null);
    check('سبب الانسحاب محفوظ للزبون',
      after.redispatchReason === 'عطل في المركبة', after.redispatchReason ?? '');
    const reoffer = await prisma.driverOffer.findFirst({
      where: { orderId: order.id, driverId: { not: driverId } },
      orderBy: { createdAt: 'desc' },
    });
    check('عرض جديد ذهب لسائق آخر', !!reoffer, reoffer?.driverId);
    check('من انسحب لم يُعرض عليه ثانيةً',
      (await prisma.driverOffer.count({
        where: { orderId: order.id, driverId, status: 'PENDING' },
      })) === 0);
    const profile = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: driverId } });
    check('السائق عاد متاحاً فوراً', profile.status === 'AVAILABLE', profile.status);
    const hist = await prisma.orderAssignmentHistory.findFirst({
      where: { orderId: order.id, action: 'DRIVER_CANCELLED' },
    });
    check('DRIVER_CANCELLED مُسجَّل بسببه', !!hist && hist.reason!.includes('عطل في المركبة'), hist?.reason ?? '');
    const notif = await prisma.notification.findFirst({
      where: { userId: customer.id, type: 'ORDER_DRIVER_CHANGED', data: { path: ['orderId'], equals: order.id } },
    });
    check('إشعار الزبون يطمئنه أن البحث مستمر',
      !!notif && notif.bodyAr.includes('لم يُلغَ'), notif?.bodyAr ?? '');
    const ticket = await prisma.supportTicket.findFirst({
      where: { orderId: order.id, type: 'DRIVER_CANCELLED' },
    });
    check('تذكرة عاجلة للعمليات (بعد الاستلام)', ticket?.priority === 'URGENT', ticket?.code);

    // السائق المنسحب لم يعد صاحب الطلب — لا يستطيع الانسحاب منه ثانيةً
    let refused = false;
    try {
      await orders.cancelByDriver(order.id, driverId, 'OTHER', 'محاولة ثانية على طلب تركه');
    } catch {
      refused = true;
    }
    check('انسحاب ثانٍ من طلب تركه مرفوض', refused);

    // "سبب آخر" بلا شرح مرفوض قبل لمس الطلب
    const second = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(second.id);
    const offer2 = await pendingOffer(second.id);
    await dispatch.acceptOffer(offer2!.id, offer2!.driverId);
    let noteRequired = false;
    try {
      await orders.cancelByDriver(second.id, offer2!.driverId, 'OTHER');
    } catch {
      noteRequired = true;
    }
    check('«سبب آخر» بلا شرح مرفوض', noteRequired);
    check('الطلب بقي كما هو بعد الرفض',
      (await prisma.order.findUniqueOrThrow({ where: { id: second.id } })).status === 'DRIVER_ASSIGNED');
    await orders.driverUpdateStatus(second.id, offer2!.driverId, OrderStatus.PICKED_UP);
    await orders.driverUpdateStatus(second.id, offer2!.driverId, OrderStatus.DELIVERING);
    await orders.driverUpdateStatus(second.id, offer2!.driverId, OrderStatus.COMPLETED);
    let afterDone = false;
    try {
      await orders.cancelByDriver(second.id, offer2!.driverId, 'VEHICLE_BREAKDOWN');
    } catch {
      afterDone = true;
    }
    check('الإلغاء بعد التسليم مرفوض', afterDone);
  }

  // ============ S13: جولات إعادة على من لم يردّ ============
  console.log('\n— S13: جولات الإعادة —');
  {
    await prisma.dispatchSettings.update({
      where: { id: 1 }, data: { maxDispatchRounds: 2, maxWaitForDriverSeconds: 900 },
    });
    // وكالة واحدة فقط في الساحة: نُخرج B بإفراغ رصيدها، فتنحصر الجولات في A
    await prisma.wallet.update({ where: { agencyId: agencyB!.id }, data: { balance: 0 } });
    await setAllDrivers('AVAILABLE');
    const order = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(order.id);

    const driversOfA = await prisma.driverProfile.count({ where: { agencyId: agencyA.id } });
    // ننتظر ما يكفي لانقضاء عروض الجولتين (مهلة 2ث لكل عرض)
    await sleep((SIM_TIMEOUT_SECONDS + 1) * 1000 * (driversOfA * 2 + 1));

    const offers = await prisma.driverOffer.findMany({
      where: { orderId: order.id }, orderBy: { createdAt: 'asc' },
    });
    const perDriver = new Map<string, number>();
    for (const o of offers) perDriver.set(o.driverId, (perDriver.get(o.driverId) ?? 0) + 1);
    const repeated = [...perDriver.values()].filter((n) => n >= 2).length;
    check('سائق لم يردّ عُرض عليه أكثر من مرة', repeated > 0,
      `عروض=${offers.length} سائقون=${perDriver.size}`);
    check('لا أحد تجاوز عدد الجولات', [...perDriver.values()].every((n) => n <= 2));

    // من رفض صراحةً لا يُعاد عليه مهما بقيت جولات
    await releaseCustomerOrders();
    await clearCreateQuota();
    await setAllDrivers('AVAILABLE');
    const rejected = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(rejected.id);
    const firstOffer = await pendingOffer(rejected.id);
    await dispatch.rejectOffer(firstOffer!.id, firstOffer!.driverId, 'sim: رفض صريح');
    const afterReject = await prisma.driverOffer.findMany({
      where: { orderId: rejected.id, driverId: firstOffer!.driverId },
    });
    check('الرافض لم يُعرض عليه ثانيةً', afterReject.length === 1,
      `${afterReject.length} عرض`);

    await prisma.wallet.update({ where: { agencyId: agencyB!.id }, data: { balance: 50 } });
    await dropOrder(order.id);
    await dropOrder(rejected.id);
  }

  // ============ زبائن الطابور (S14/S15) ============
  // المنصة تسمح بطلب فعّال واحد لكل زبون، فطابورٌ من عدة طلبات منتظرة معاً
  // لا يمكن بناؤه بزبون واحد مهما فعلنا — يحتاج زبائن مستقلين.
  const queueCustomers: { id: string; addressId: string }[] = [];
  for (const q of [
    { phone: '+962792222201', name: 'زبون الطابور ١' },
    { phone: '+962792222202', name: 'زبون الطابور ٢' },
    { phone: '+962792222203', name: 'زبون الطابور ٣' },
    { phone: '+962792222204', name: 'زبون الطابور ٤' },
  ]) {
    const u = await prisma.user.upsert({
      where: { phone: q.phone },
      create: { phone: q.phone, name: q.name },
      update: {},
    });
    const prev = await prisma.address.findFirst({
      where: { userId: u.id, label: SIM_ADDRESS.label },
    });
    const addr = prev
      ? await prisma.address.update({
          where: { id: prev.id },
          data: { lat: SIM_ADDRESS.lat, lng: SIM_ADDRESS.lng },
        })
      : await prisma.address.create({
          data: {
            userId: u.id, label: SIM_ADDRESS.label, street: 'شارع المحاكاة',
            lat: SIM_ADDRESS.lat, lng: SIM_ADDRESS.lng,
          },
        });
    queueCustomers.push({ id: u.id, addressId: addr.id });
  }

  /** نظير `prepareCreate` + `orders.create` لكن لزبون طابور لا للزبون الأصلي */
  const newQueueOrder = async (qc: { id: string; addressId: string }) => {
    await prisma.order.updateMany({
      where: {
        customerId: qc.id,
        status: {
          in: [
            'CREATED', 'SEARCHING', 'WAITING_FOR_DRIVER', 'AGENCY_ASSIGNED',
            'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING',
          ],
        },
      },
      data: { status: 'CANCELLED', cancelReason: 'sim cleanup' },
    });
    await redis.del(`order:create:${qc.id}`);
    return orders.create({
      customerId: qc.id,
      addressId: qc.addressId,
      items: [{ bottleTypeId: types[0].id, qty: 1 }],
    });
  };

  /** `dropOrder` يسقط المنتظر فقط — الطابور يخلّف طلبات استُؤنفت أيضاً */
  const forceCancel = (ids: string[]) =>
    prisma.order.updateMany({
      where: {
        id: { in: ids },
        status: { notIn: ['COMPLETED', 'CANCELLED', 'SEARCH_FAILED'] },
      },
      data: { status: 'CANCELLED', cancelReason: 'sim cleanup' },
    });

  /** يبني طابور انتظار من `n` طلبات، الأقدم أولاً، ويعيد معرّفاتها بالترتيب */
  const buildQueue = async (n: number) => {
    await setAllDrivers('BUSY');
    const ids: string[] = [];
    for (const qc of queueCustomers.slice(0, n)) {
      const o = await newQueueOrder(qc);
      await dispatch.dispatchOrder(o.id);
      ids.push(o.id);
      // الترتيب يُقرأ من `waitingSince`، وطلبات تُنشأ في تكة واحدة قد تتساوى
      // طوابعها فيصير «الأقدم» غير محدَّد ويصبح الفحص عشوائياً
      await sleep(1100);
    }
    return ids;
  };

  // نافذة انتظار أوسع من زمن السيناريوهين، وتكة أبعد من أن تستأنف طلباً
  // بينما نحن نقيس — الطابور هنا يُحرَّك بـ`onDriverAvailable` وحده
  await prisma.dispatchSettings.update({
    where: { id: 1 },
    data: { maxWaitForDriverSeconds: 300, waitRetryIntervalSeconds: 280 },
  });

  // ============ S14: عدالة الطابور — الأقدم أولاً ============
  //
  // S8 أثبت أن طلباً منتظراً واحداً يُستأنف عند توفر سائق. لكن الطابور الحقيقي
  // فيه أكثر من طلب ينتظر معاً، والسؤال الذي لم يُفحص: أيُّها يلتقط السائق الذي
  // فرغ؟ المحرك يرتّب بـ`waitingSince ASC` — وهذا يثبت أن الترتيب يُحترم فعلاً
  // لا أنه نيّة في الاستعلام.
  console.log('\n— S14: عدالة الطابور (FIFO) —');
  {
    const q = await buildQueue(3);
    const before = await prisma.order.findMany({
      where: { id: { in: q } },
      select: { id: true, status: true },
    });
    check('الطلبات الثلاثة دخلت الانتظار معاً',
      before.length === 3 && before.every((o) => o.status === 'WAITING_FOR_DRIVER'),
      before.map((o) => o.status).join(' / '));

    // سائق واحد فقط يفرغ — مقعد واحد لثلاثة منتظرين
    const driver = await prisma.driverProfile.findFirstOrThrow({
      where: { agencyId: agencyA.id, isVerified: true },
    });
    await prisma.driverProfile.update({
      where: { userId: driver.userId }, data: { status: 'AVAILABLE' },
    });
    await dispatch.onDriverAvailable(driver.userId);

    const after = await prisma.order.findMany({
      where: { id: { in: q } },
      select: { id: true, status: true },
    });
    const status = new Map(after.map((o) => [o.id, o.status]));
    check('الأقدم انتظاراً هو من التقط السائق',
      status.get(q[0]) === 'AGENCY_ASSIGNED', `الأول=${status.get(q[0])}`);
    check('لم يتخطَّ أحدٌ دوره: التاليان باقيان في الانتظار',
      status.get(q[1]) === 'WAITING_FOR_DRIVER' && status.get(q[2]) === 'WAITING_FOR_DRIVER',
      `${status.get(q[1])} / ${status.get(q[2])}`);
    const offer = await pendingOffer(q[0]);
    check('العرض ذهب للسائق الذي فرغ', offer?.driverId === driver.userId);
    check('لا عرض تسرّب لطلب لاحق في الطابور',
      !(await pendingOffer(q[1])) && !(await pendingOffer(q[2])));

    await forceCancel(q);
    await resetDrivers();
  }

  // ============ S15: السعة — مقعد لكل سائق فرغ، لا أكثر ============
  //
  // أربعة منتظرين وسائقان يفرغان: يجب أن يخرج اثنان بالضبط ويبقى اثنان
  // منتظرَين — لا أن يفشل الفائض، ولا أن يُحمَّل سائقٌ عرضين في آنٍ واحد.
  // الأخيرة هي المقصد: `untriedDrivers` يفلتر عروض **الطلب نفسه** فقط، فلا
  // شيء في الترشيح يمنع ترشيح سائق يحمل عرضاً قائماً على طلب آخر — والحارس
  // الوحيد داخل `onDriverAvailable` يحمي دورة ذلك السائق لا اختيار سواه.
  console.log('\n— S15: السعة عند شحّ السائقين —');
  {
    const q = await buildQueue(4);
    const before = await prisma.order.findMany({
      where: { id: { in: q } },
      select: { id: true, status: true },
    });
    check('أربعة طلبات في الانتظار',
      before.length === 4 && before.every((o) => o.status === 'WAITING_FOR_DRIVER'),
      `${before.filter((o) => o.status === 'WAITING_FOR_DRIVER').length} من 4`);

    const freed = await prisma.driverProfile.findMany({
      where: { agencyId: agencyA.id, isVerified: true },
      take: 2,
    });
    check('وكالة A فيها سائقان للتجربة', freed.length === 2, `${freed.length} سائق`);
    for (const d of freed) {
      await prisma.driverProfile.update({
        where: { userId: d.userId }, data: { status: 'AVAILABLE' },
      });
      await dispatch.onDriverAvailable(d.userId);
    }

    const after = await prisma.order.findMany({
      where: { id: { in: q } },
      select: { id: true, status: true },
    });
    const resumed = after.filter((o) => o.status === 'AGENCY_ASSIGNED');
    const waiting = after.filter((o) => o.status === 'WAITING_FOR_DRIVER');
    check('عدد الخارجين من الانتظار = عدد السائقين الذين فرغوا',
      resumed.length === freed.length, `${resumed.length} خرج / ${freed.length} سائق`);
    check('الفائض بقي منتظراً ولم يفشل',
      waiting.length === q.length - freed.length, `${waiting.length} منتظر`);
    check('الخارجان هما الأقدمان لا الأحدثان',
      resumed.every((o) => o.id === q[0] || o.id === q[1]),
      `الرتب: ${resumed.map((o) => q.indexOf(o.id) + 1).sort().join(',')}`);
    check('لا طلب ضاع من الطابور',
      resumed.length + waiting.length === q.length,
      `${resumed.length}+${waiting.length} من ${q.length}`);

    const offers = await prisma.driverOffer.findMany({
      where: { orderId: { in: q }, status: 'PENDING' },
      select: { driverId: true },
    });
    const distinct = new Set(offers.map((o) => o.driverId)).size;
    check('لا سائق حُمِّل عرضين في آنٍ واحد',
      distinct === offers.length, `${offers.length} عرض على ${distinct} سائق`);

    await forceCancel(q);
    await resetDrivers();
  }

  // ============ S16: انسحاب لسبب يخصّ الزبون → يُسأل قبل إرسال سائق آخر ====
  console.log('\n— S16: قرار الزبون بعد انسحاب السائق —');
  {
    await setAllDrivers('AVAILABLE');

    // (أ) نعم، ابحث لي عن سائق آخر
    const yes = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(yes.id);
    const o1 = await pendingOffer(yes.id);
    await dispatch.acceptOffer(o1!.id, o1!.driverId);
    await orders.cancelByDriver(yes.id, o1!.driverId, 'CUSTOMER_UNREACHABLE');

    const asked = await prisma.order.findUniqueOrThrow({ where: { id: yes.id } });
    check('الطلب موقوف بانتظار قرار الزبون', asked.redispatchAskedAt !== null);
    check('الطلب بلا سائق ولم يُلغَ',
      asked.driverId === null && asked.status === 'AGENCY_ASSIGNED', asked.status);
    check('لا عرض جديد قبل رد الزبون',
      (await pendingOffer(yes.id)) === null);
    const ask = await prisma.notification.findFirst({
      where: { userId: customer.id, type: 'ORDER_REDISPATCH_ASK', data: { path: ['orderId'], equals: yes.id } },
    });
    check('سؤال وصل للزبون', !!ask, ask?.titleAr);

    await orders.answerRedispatch(yes.id, customer.id, true);
    const resumed = await prisma.order.findUniqueOrThrow({ where: { id: yes.id } });
    check('السؤال انطوى بعد الرد', resumed.redispatchAskedAt === null);
    check('عرض جديد خرج بعد موافقة الزبون',
      (await prisma.driverOffer.count({
        where: { orderId: yes.id, driverId: { not: o1!.driverId } },
      })) > 0);
    await forceCancel([yes.id]);
    await resetDrivers();

    // (ب) لا، ألغِ الطلب
    const no = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(no.id);
    const o2 = await pendingOffer(no.id);
    await dispatch.acceptOffer(o2!.id, o2!.driverId);
    await orders.cancelByDriver(no.id, o2!.driverId, 'CUSTOMER_REQUESTED_CANCEL');
    await orders.answerRedispatch(no.id, customer.id, false);
    const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: no.id } });
    check('رفض الزبون يُلغي الطلب', cancelled.status === 'CANCELLED', cancelled.status);
    check('المُلغي مُسجَّل أنه الزبون', cancelled.cancelledByUserId === customer.id);

    // رد ثانٍ على طلب لا قرار معلّق عليه مرفوض
    let twice = false;
    try {
      await orders.answerRedispatch(no.id, customer.id, true);
    } catch {
      twice = true;
    }
    check('رد ثانٍ بلا قرار معلّق مرفوض', twice);

    // (ج) انقضاء المهلة بلا رد → إلغاء تلقائي بلا خصم
    await resetDrivers();
    const mute = await newOrderKeepDrivers();
    await dispatch.dispatchOrder(mute.id);
    const o3 = await pendingOffer(mute.id);
    await dispatch.acceptOffer(o3!.id, o3!.driverId);
    await orders.cancelByDriver(mute.id, o3!.driverId, 'CUSTOMER_UNREACHABLE');
    await dispatch.handleRedispatchTimeout(mute.id); // نستدعيها مباشرة بدل انتظار ١٥ دقيقة
    const expired = await prisma.order.findUniqueOrThrow({ where: { id: mute.id } });
    check('انقضاء المهلة يُلغي الطلب', expired.status === 'CANCELLED', expired.status);
    check('سبب الإلغاء يذكر عدم الرد',
      (expired.cancelReason ?? '').includes('لم يصل رد'), expired.cancelReason ?? '');
    // مهلة على طلب لا قرار عليه لا تفعل شيئاً
    await dispatch.handleRedispatchTimeout(no.id);
    check('مهلة على طلب مُلغى سلفاً لا تفعل شيئاً',
      (await prisma.order.findUniqueOrThrow({ where: { id: no.id } })).cancelReason ===
        cancelled.cancelReason);
    await resetDrivers();
  }

  // ============ إعادة الإعدادات ============
  await dropOrder(waitingOrderId);
  await prisma.dispatchSettings.update({
    where: { id: 1 },
    data: {
      offerTimeoutSeconds: 45,
      maxWaitForDriverSeconds: 900,
      waitRetryIntervalSeconds: 30,
    },
  });
  await resetDrivers();

  console.log(failures === 0 ? '\n🎉 محرك التوزيع: كل السيناريوهات نجحت' : `\n⚠️ ${failures} فحص فشل`);
  await app.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
