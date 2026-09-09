import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import http from 'http';
import Redis from 'ioredis';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { Server } from 'socket.io';
import { MiniRedis } from './support/mini-redis';

/**
 * إثبات أن حاويتَي API تتصرفان كقناة واحدة، وأن العامل يستطيع البثّ بلا
 * خادم Socket.IO — وهما ما يجعل تشغيل نسختين آمناً.
 *
 * الاختبار يشغّل خادمَي Socket.IO حقيقيين على منفذين، وعميلاً حقيقياً على
 * كلٍّ منهما، وباعثاً منفصلاً يمثّل العامل. لا محاكاة لشيء داخل الشيفرة
 * المختبَرة: المحوّل والباعث وioredis نسخ الإنتاج نفسها.
 */

const NS = '/v2';
let mini: MiniRedis;
let url: string;
const clients: ClientSocket[] = [];
const servers: { io: Server; http: http.Server; redis: Redis[] }[] = [];
const extraRedis: Redis[] = [];

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** خادم Socket.IO بمحوّل Redis — نظير حاوية API واحدة */
async function startApiInstance(label: string) {
  const pub = new Redis(url);
  const sub = new Redis(url);
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  io.adapter(createAdapter(pub, sub));
  // نفس منطق الغرف في TrackingV2Gateway: كل متصل يدخل user:{id}
  // و driver:{id} — وهي الغرف التي يبثّ إليها المحرك.
  io.of(NS).on('connection', (socket) => {
    const uid = socket.handshake.auth?.userId as string | undefined;
    if (!uid) return socket.disconnect(true);
    void socket.join(`user:${uid}`);
    void socket.join(`driver:${uid}`);
  });
  await new Promise<void>((res) => httpServer.listen(0, '127.0.0.1', res));
  const port = (httpServer.address() as { port: number }).port;
  servers.push({ io, http: httpServer, redis: [pub, sub] });
  console.log(`    (${label} على المنفذ ${port})`);
  return port;
}

function connectClient(port: number, userId: string): Promise<ClientSocket> {
  const c = ioClient(`http://127.0.0.1:${port}${NS}`, {
    auth: { userId },
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(c);
  return new Promise((res, rej) => {
    c.on('connect', () => res(c));
    c.on('connect_error', rej);
    setTimeout(() => rej(new Error('مهلة الاتصال')), 4000);
  });
}

/** ينتظر حدثاً بعينه، ويعيد null عند انقضاء المهلة */
function waitFor(c: ClientSocket, event: string, ms = 2500): Promise<unknown> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(event, (payload: unknown) => { clearTimeout(t); res(payload); });
  });
}

async function main() {
  mini = new MiniRedis();
  const port = await mini.start();
  url = `redis://127.0.0.1:${port}`;
  console.log(`Redis مصغّر على ${url}\n`);

  console.log('تشغيل حاويتين وعميلين:');
  const p1 = await startApiInstance('API#1');
  const p2 = await startApiInstance('API#2');
  const [io1, io2] = servers.map((s) => s.io);

  const driverOnApi1 = await connectClient(p1, 'driver-A');
  const driverOnApi2 = await connectClient(p2, 'driver-B');
  // مهلة قصيرة حتى ينشر المحوّل عضوية الغرف بين الحاويتين
  await new Promise((r) => setTimeout(r, 300));
  console.log('');

  // ---- 1) API#2 يبثّ، والعميل على API#1 يستقبل ----
  console.log('عبور الحاويات:');
  const a = waitFor(driverOnApi1, 'offer:new');
  io2.of(NS).to('driver:driver-A').emit('offer:new', { offerId: 'o1' });
  const gotA = await a;
  check('API#2 → عميل موصول بـAPI#1', gotA !== null,
        gotA === null ? 'لم يصل الحدث' : '');

  // ---- 2) العكس ----
  const b = waitFor(driverOnApi2, 'offer:new');
  io1.of(NS).to('driver:driver-B').emit('offer:new', { offerId: 'o2' });
  const gotB = await b;
  check('API#1 → عميل موصول بـAPI#2', gotB !== null,
        gotB === null ? 'لم يصل الحدث' : '');

  // ---- 3) العامل (باعث بلا خادم) → كلا العميلين ----
  console.log('\nالعامل بلا خادم Socket.IO:');
  const workerRedis = new Redis(url);
  extraRedis.push(workerRedis);
  const workerEmitter = new Emitter(workerRedis).of(NS);

  const c = waitFor(driverOnApi1, 'offer:closed');
  workerEmitter.to('driver:driver-A').emit('offer:closed', { result: 'EXPIRED' });
  const gotC = await c;
  check('العامل → عميل موصول بـAPI#1', gotC !== null,
        gotC === null ? 'لم يصل الحدث — البثّ سقط بصمت' : '');

  const d = waitFor(driverOnApi2, 'offer:closed');
  workerEmitter.to('driver:driver-B').emit('offer:closed', { result: 'EXPIRED' });
  const gotD = await d;
  check('العامل → عميل موصول بـAPI#2', gotD !== null,
        gotD === null ? 'لم يصل الحدث — البثّ سقط بصمت' : '');

  // ---- 4) حمولة الحدث تصل سليمة ----
  const e = waitFor(driverOnApi1, 'order:status');
  workerEmitter.to('user:driver-A').emit('order:status', {
    orderId: 'ord-9', status: 'DRIVER_ASSIGNED', noteAr: 'عربي',
  });
  const gotE = (await e) as { orderId?: string; noteAr?: string } | null;
  check('الحمولة تصل سليمة (عربية ومفاتيح)',
        gotE?.orderId === 'ord-9' && gotE?.noteAr === 'عربي',
        JSON.stringify(gotE));

  // ---- 5) البثّ لغرفة متعددة لا يكرّر الحدث ----
  console.log('\nالغرف:');
  let hits = 0;
  driverOnApi1.on('order:status', () => hits++);
  workerEmitter
    .to([`order:ord-1`, `user:driver-A`, 'admin'])
    .emit('order:status', { orderId: 'ord-1', status: 'COMPLETED' });
  await new Promise((r) => setTimeout(r, 600));
  check('عضوية غرف متعددة لا تكرّر الحدث', hits === 1, `وصل ${hits} مرة`);

  // ---- 6) غرفة لا ينتمي إليها العميل لا تصله ----
  const f = await waitFor(driverOnApi1, 'offer:new', 700);
  check('غرفة أخرى لا تصل العميل الخطأ', f === null);

  // ---- 7) العزل بين الأسماء (namespace) ----
  const wrongNsRedis = new Redis(url);
  extraRedis.push(wrongNsRedis);
  const wrongNs = new Emitter(wrongNsRedis).of('/wrong');
  const g = await (async () => {
    const w = waitFor(driverOnApi1, 'offer:new', 700);
    wrongNs.to('driver:driver-A').emit('offer:new', { offerId: 'x' });
    return w;
  })();
  check('اسم نطاق مختلف لا يصل /v2', g === null);

  console.log(`\n${pass} نجح، ${fail} فشل`);
  return fail;
}

// أوامر معلّقة على اتصال يُغلق ترمي رفضاً غير ملتقَط بعد نجاح الاختبار.
// إغلاق مرتّب أولاً، وهذا الحارس يمنع الضجيج المتبقي من قلب النتيجة.
process.on('unhandledRejection', () => undefined);

main()
  .then(async (failed) => {
    // الإغلاق بترتيب: عملاء، ثم اتصالات Redis (مع كتم أخطاء القطع)، ثم
    // الخوادم. لا ننتظر ردّ `io.close()`: محوّل Redis يبقيه معلّقاً حتى
    // تُغلق اشتراكاته، والعملية تنتهي بـexit على أي حال — والمقصود من
    // الاختبار هو التحققات أعلاه لا ترتيب تفكيك المكتبات.
    for (const c of clients) c.close();
    for (const r of [...servers.flatMap((s) => s.redis), ...extraRedis]) {
      r.on('error', () => undefined);
      r.disconnect();
    }
    for (const s of servers) {
      s.io.close();
      s.http.close();
    }
    await mini.stop();
    console.log(failed ? 'النتيجة: فشل' : 'النتيجة: نجاح');
    process.exit(failed ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('انهار الاختبار:', e);
    try { await mini?.stop(); } catch { /* ignore */ }
    process.exit(1);
  });
