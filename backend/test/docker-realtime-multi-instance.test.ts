import jwt from 'jsonwebtoken';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * المرحلة 3.5 — التحقق الحقيقي من Socket.IO عبر حاويتَي API فعليتين على
 * Docker Compose، بـRedis حقيقي (لا MiniRedis من المرحلة 1). يتصل بالخدمات
 * الحيّة على المنفذين 3000 و3001 مباشرة — لا خوادم مصطنعة داخل الاختبار.
 *
 * **متطلبات التشغيل:** `docker compose up -d db redis api worker` ثم
 * (تراكب المرحلة 3) `-f docker-compose.portability.yml up -d api2` — كلاهما
 * صحّي، وقاعدة مُهاجَرة (docker-migrate.sh نجح) بمستخدمين حقيقيين.
 *
 * التحقق يبني توكن v2 حقيقياً (نفس JWT_SECRET/issuer/audience التي تقرأها
 * الحاويتان من docker-compose.yml) لمستخدمَين سائقَين حقيقيَّين مزروعَين
 * بالبذور — لا نظير مبنيّ داخل الاختبار للجزء الذي يُختبر فعلياً.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'jordan-gas-dev-secret-change-in-production';
const JWT_ISSUER = 'jordan-gas-api';
const JWT_AUDIENCE = 'jordan-gas-v2';

// من migrate.log الحقيقي لهذه البيئة — سائقان نشطان مزروعان بالبذور
const DRIVER_A = '3cc24d15-b1da-40c3-991e-2ac4dfa02c8c';
const DRIVER_B = 'f2e1539d-47de-484b-a189-febd01d0aab6';

const API1_URL = process.env.PHASE3_API1_URL || 'http://localhost:3000';
const API2_URL = process.env.PHASE3_API2_URL || 'http://localhost:3001';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'v2' }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '5m',
  });
}

function connect(baseUrl: string, userId: string): Promise<ClientSocket> {
  const c = ioClient(`${baseUrl}/v2`, {
    auth: { token: tokenFor(userId) },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 300,
  });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`مهلة الاتصال بـ${baseUrl}`)), 6000);
    c.on('connect', () => { clearTimeout(t); res(c); });
    c.on('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}

function waitFor(c: ClientSocket, event: string, ms = 4000): Promise<unknown> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(event, (payload: unknown) => { clearTimeout(t); res(payload); });
  });
}

async function main() {
  console.log(`API#1: ${API1_URL}  API#2: ${API2_URL}\n`);

  console.log('الاتصال بالحاويتين الحقيقيتين بتوكن v2 حقيقي:');
  const clientOnApi1 = await connect(API1_URL, DRIVER_A);
  const clientOnApi2 = await connect(API2_URL, DRIVER_B);
  check('عميل A متصل بـAPI#1 (Docker حقيقي)', clientOnApi1.connected);
  check('عميل B متصل بـAPI#2 (Docker حقيقي)', clientOnApi2.connected);
  await new Promise((r) => setTimeout(r, 300)); // انتشار عضوية الغرف عبر محوّل Redis

  // ---- الغاية الحقيقية: بثّ عبر الحاويات فوق Redis حقيقي على Docker ----
  console.log('\nعبور الحاويات فوق Redis حقيقي (لا MiniRedis):');
  // يستدعي المحرك عبر الخادم مباشرة بمحاكاة استدعاء REST داخلي غير متاح من
  // خارج التطبيق؛ البديل الصحيح هنا هو ما تختبره فعلاً: اشتراك الغرفة نفسها
  // التي يبثّ إليها TrackingV2Gateway.emitOfferNew — driver:{id}. الطريقة
  // الوحيدة لبثّ حقيقي من خارج العملية هي عبر Redis نفسه بنفس بروتوكول
  // الباعث الذي تستعمله المرحلة 1.2 — نستعمله هنا مباشرة ضد Redis الحقيقي.
  const { Emitter } = await import('@socket.io/redis-emitter');
  const Redis = (await import('ioredis')).default;
  const externalRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  externalRedis.on('error', () => undefined);
  const emitter = new Emitter(externalRedis).of('/v2');

  const a = waitFor(clientOnApi1, 'offer:new');
  emitter.to(`driver:${DRIVER_A}`).emit('offer:new', { offerId: 'phase3-a' });
  const gotA = (await a) as { offerId?: string } | null;
  check('بثّ خارجي عبر Redis الحقيقي يصل عميلاً على API#1', gotA?.offerId === 'phase3-a',
        gotA === null ? 'لم يصل — تحقق أن REDIS_URL يشير لنفس Redis الذي تستعمله الحاويتان' : '');

  const b = waitFor(clientOnApi2, 'offer:new');
  emitter.to(`driver:${DRIVER_B}`).emit('offer:new', { offerId: 'phase3-b' });
  const gotB = (await b) as { offerId?: string } | null;
  check('بثّ خارجي عبر Redis الحقيقي يصل عميلاً على API#2', gotB?.offerId === 'phase3-b');

  // ---- العزل: غرفة خاطئة، ونطاق خاطئ ----
  console.log('\nالعزل بين الغرف والنطاقات على البنية الحقيقية:');
  const wrongRoom = await waitFor(clientOnApi1, 'offer:new', 1200);
  emitter.to(`driver:not-a-real-user`).emit('offer:new', { offerId: 'wrong-room' });
  const stillNothing = await waitFor(clientOnApi1, 'offer:new', 1200);
  check('غرفة سائق آخر لا تصل هذا العميل', stillNothing === null, JSON.stringify(wrongRoom));

  const wrongNsRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  wrongNsRedis.on('error', () => undefined);
  const wrongNs = new Emitter(wrongNsRedis).of('/wrong-namespace');
  const nsTest = waitFor(clientOnApi1, 'offer:new', 1200);
  wrongNs.to(`driver:${DRIVER_A}`).emit('offer:new', { offerId: 'wrong-ns' });
  const gotWrongNs = await nsTest;
  check('نطاق مختلف لا يصل /v2 الحقيقي', gotWrongNs === null);

  // ---- الحمولة العربية سليمة عبر الشبكة الحقيقية ----
  console.log('\nسلامة الحمولة العربية عبر Docker الحقيقي:');
  const arabicTest = waitFor(clientOnApi1, 'order:status');
  emitter.to(`user:${DRIVER_A}`).emit('order:status', {
    orderId: 'ord-phase3', status: 'DRIVER_ASSIGNED', noteAr: 'وصل السائق — عربي كامل ✓',
  });
  const gotArabic = (await arabicTest) as { noteAr?: string } | null;
  check('النص العربي يصل سليماً بلا تلف ترميز عبر الشبكة الحقيقية',
        gotArabic?.noteAr === 'وصل السائق — عربي كامل ✓', JSON.stringify(gotArabic));

  // ---- إعادة الاتصال بعد إعادة تشغيل حاوية API فعلياً ----
  // (تُدار من سكربت shell خارجي يعيد تشغيل الحاوية فعلاً — انظر التقرير
  // لتفاصيل هذا الجزء المُنفَّذ يدوياً بالتوازي مع Docker الحقيقي)

  console.log(`\n${pass} نجح، ${fail} فشل`);

  clientOnApi1.close();
  clientOnApi2.close();
  externalRedis.disconnect();
  wrongNsRedis.disconnect();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
