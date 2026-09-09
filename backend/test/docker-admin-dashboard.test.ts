import jwt from 'jsonwebtoken';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * المرحلة 3.5 — يثبّت اتصال لوحة الأدمن الحقيقية (`backend/public/admin/
 * index.html`) بعد إصلاح `transports: ['websocket']` (كوميت e789caf)، ضد
 * حاوية API حقيقية على Docker — لا خادماً معاد بناؤه داخل الاختبار.
 *
 * القناة هنا هي النطاق الافتراضي (`TrackingGateway`، لا `/v2`) — نفس ما
 * تتصل به `io({ transports: ['websocket'], auth: { token } })` حرفياً في
 * index.html:193. المستخدم مستخدَم ADMIN حقيقي من قاعدة legacy المُهاجَرة.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'jordan-gas-dev-secret-change-in-production';
const ADMIN_USER_ID = 'cmtqum3qq000c9i1h2g8wnk4y'; // ADMIN حقيقي من البذور
const API1_URL = process.env.PHASE3_API1_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

// توقيع مطابق لما يتوقعه TrackingGateway.handleConnection: payload.sub وpayload.role
const adminToken = jwt.sign({ sub: ADMIN_USER_ID, role: 'ADMIN' }, JWT_SECRET);

async function main() {
  console.log(`لوحة الأدمن ← ${API1_URL} (النطاق الافتراضي، النمط الحقيقي من index.html):\n`);

  // نفس استدعاء io() بالضبط كما في index.html:193 بعد الإصلاح
  const socket: ClientSocket = ioClient(API1_URL, {
    transports: ['websocket'],
    auth: { token: adminToken },
  });

  const connected = await new Promise<boolean>((res) => {
    socket.on('connect', () => res(true));
    socket.on('connect_error', () => res(false));
    setTimeout(() => res(false), 6000);
  });
  check('لوحة الأدمن تتصل بحاوية API حقيقية بنمط websocket فقط', connected);

  if (connected) {
    check(
      'النقل الفعلي المستخدم هو websocket (لا polling) على Docker الحقيقي',
      socket.io.engine.transport.name === 'websocket',
    );
  }

  // اكتشاف حقيقي أثناء بناء هذا الاختبار — لا افتراض مسبق: AppModule
  // (src/app.module.ts) يوثّق صراحةً أن النظام القديم بأكمله (auth/orders/
  // admin/drivers/catalog/payments/tracking v1) أُزيل من التسجيل منذ
  // 8c920c7 "retire v1 API" — قبل أي عمل في هذه المحادثة بكثير. فـ
  // TrackingGateway (النطاق الافتراضي الذي تتصل به لوحة الأدمن) **لا يعمل
  // فعلياً** رغم بقاء ملفه في backend/src/tracking. الاتصال ينجح على
  // مستوى النقل (Engine.IO خادمٌ واحد يخدم كل النطاقات) لكن لا معالج
  // تطبيقي يستقبل التوكن أو ينضم لأي غرفة — فبثّ 'admin' لن يصل أبداً
  // بصرف النظر عن صحة إصلاح `transports: ['websocket']`. هذا عطل موجود
  // مسبقاً في لوحة الأدمن الثابتة، لا علاقة له بإصلاح النقل ولا بأي عمل
  // من المراحل 1-3 — واختبار هذه النقطة هنا يوثّقه لا يتجاهله.
  console.log('\nاستقبال أحداث اللوحة الحقيقية عبر Redis الحقيقي:');
  console.log('  (توقَّع الفشل هنا — TrackingGateway معطَّل من AppModule، انظر التعليق أعلاه)');
  if (connected) {
    // النطاق الافتراضي (لا /v2) — TrackingGateway ليس له اسم نطاق صريح
    const { Emitter } = await import('@socket.io/redis-emitter');
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    redis.on('error', () => undefined);
    const emitter = new Emitter(redis); // بلا .of() — النطاق الافتراضي

    const a = new Promise((res) => {
      const t = setTimeout(() => res(null), 3000);
      socket.once('order:new', (p: unknown) => { clearTimeout(t); res(p); });
    });
    emitter.to('admin').emit('order:new', { id: 'phase3-admin-order' });
    const gotOrderNew = (await a) as { id?: string } | null;
    // لا نُفشل الاختبار على هذا — النتيجة متوقَّعة ومُوثَّقة أعلاه. الهدف
    // تسجيل الحالة الحقيقية بدقة لا اختراع تحقّق كاذب.
    console.log(
      gotOrderNew === null
        ? '  info order:new لم يصل — متوقَّع (TrackingGateway معطَّل، ليس عطلاً في إصلاح النقل)'
        : `  info order:new وصل فعلاً (${JSON.stringify(gotOrderNew)}) — إن كان هذا صحيحاً فقد أُعيد تفعيل legacy، حدِّث هذا التعليق`,
    );

    redis.disconnect();
  } else {
    fail++;
    console.log('  FAIL تخطّي اختبار الأحداث — الاتصال الأساسي فشل');
  }

  console.log(`\n${pass} نجح، ${fail} فشل`);
  socket.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
