import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { RealtimeEmitter } from '../src/v2/tracking/realtime.emitter';
import { MiniRedis } from './support/mini-redis';

/**
 * سلوك Redis عند الانقطاع والعودة — يجيب سؤالين عمليين:
 *  1. هل يقلع التطبيق وRedis ساقط؟ (أي: هل Redis شرط إقلاع؟)
 *  2. هل تعود القناة الحيّة تلقائياً بعد عودة Redis؟
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const waitFor = (c: ClientSocket, ev: string, ms = 3000) =>
  new Promise<unknown>((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(ev, (p: unknown) => { clearTimeout(t); res(p); });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conns: Redis[] = [];
  const mk = (url: string) => {
    const r = new Redis(url, { retryStrategy: (t) => Math.min(t * 200, 2000) });
    r.on('error', () => undefined);
    conns.push(r);
    return r;
  };

  // ---- 1) الإقلاع وRedis ساقط ----
  console.log('Redis ساقط عند الإقلاع:');
  const deadUrl = 'redis://127.0.0.1:59999'; // منفذ لا يستمع عليه أحد
  let constructed = true;
  let emitThrew = false;
  try {
    const emitter = new RealtimeEmitter(mk(deadUrl));
    // البثّ بلا اتصال: ioredis يُدرج الأمر في طابور بدل أن يرمي
    emitter.to(undefined, 'driver:x').emit('offer:new', { offerId: 'q' });
  } catch {
    emitThrew = true;
    constructed = false;
  }
  check('إنشاء RealtimeEmitter لا يفشل وRedis ساقط', constructed);
  check('البثّ بلا اتصال لا يرمي استثناءً يُسقط العملية', !emitThrew);

  // ---- 2) الانقطاع ثم العودة ----
  console.log('\nانقطاع Redis ثم عودته على نفس المنفذ:');
  const mini = new MiniRedis();
  const port = await mini.start();
  const url = `redis://127.0.0.1:${port}`;

  const httpServer = http.createServer();
  const io = new Server(httpServer);
  io.adapter(createAdapter(mk(url), mk(url)));
  io.of('/v2').on('connection', (s) => {
    void s.join(`driver:${s.handshake.auth.userId}`);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const p = (httpServer.address() as { port: number }).port;

  const client = ioClient(`http://127.0.0.1:${p}/v2`, {
    auth: { userId: 'd1' }, transports: ['websocket'], reconnection: true,
  });
  await new Promise<void>((res, rej) => {
    client.on('connect', () => res());
    client.on('connect_error', rej);
  });
  await sleep(200);

  const emitter = new RealtimeEmitter(mk(url));
  const before = await (async () => {
    const w = waitFor(client, 'offer:new');
    emitter.to(undefined, 'driver:d1').emit('offer:new', { offerId: 'before' });
    return w;
  })();
  check('البثّ يعمل قبل الانقطاع', before !== null);

  // إسقاط Redis — العملاء يدخلون إعادة المحاولة
  await mini.stop();
  await sleep(400);
  const during = await (async () => {
    const w = waitFor(client, 'offer:new', 800);
    emitter.to(undefined, 'driver:d1').emit('offer:new', { offerId: 'during' });
    return w;
  })();
  check('أثناء الانقطاع لا يصل حدث (متوقَّع — لا قناة)', during === null);
  check('العملية لم تسقط أثناء انقطاع Redis', true);

  // عودة Redis على نفس المنفذ — لتنجح إعادة اتصال ioredis التلقائية
  const mini2 = new MiniRedis();
  await mini2.startOn(port);
  // مهلة إعادة الاتصال + إعادة الاشتراك بقنوات المحوّل
  await sleep(3000);

  const after = await (async () => {
    const w = waitFor(client, 'offer:new', 3000);
    emitter.to(undefined, 'driver:d1').emit('offer:new', { offerId: 'after' });
    return w;
  })();
  check('البثّ يعود تلقائياً بعد عودة Redis', after !== null,
        after === null ? 'لم يُستأنف — إعادة الاشتراك لم تحدث' : '');

  console.log(`\n${pass} نجح، ${fail} فشل`);
  client.close();
  for (const r of conns) r.disconnect();
  io.close();
  httpServer.close();
  await mini2.stop();
  return fail;
}

process.on('unhandledRejection', () => undefined);

// حارس زمني صارم: اختبار انقطاع Redis يعتمد على مهل إعادة اتصال حقيقية،
// وتعليقٌ في مكتبة خارجية (ioredis يعيد محاولة، socket.io-client يعيد
// الوصل) يجب ألا يُجمّد مجموعة الاختبارات كلها إلى الأبد.
const watchdog = setTimeout(() => {
  console.error('انتهت مهلة الاختبار (20s) — إنهاء قسري');
  process.exit(1);
}, 20_000);
watchdog.unref();

main()
  .then((f) => {
    clearTimeout(watchdog);
    console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح');
    process.exit(f ? 1 : 0);
  })
  .catch((e) => {
    clearTimeout(watchdog);
    console.error('انهار الاختبار:', e);
    process.exit(1);
  });
