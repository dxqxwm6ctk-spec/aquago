import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { RealtimeEmitter } from '../src/v2/tracking/realtime.emitter';
import { MiniRedis } from './support/mini-redis';

/**
 * يختبر `RealtimeEmitter` نفسها — لا نظيراً مكتوباً في الاختبار.
 *
 * الاختبار السابق أثبت أن البروتوكول يعمل؛ هذا يثبت أن الغلاف الذي يستعمله
 * `TrackingV2Gateway` فعلياً يختار الوجهة الصحيحة في الدورين، وأن نطاقه
 * `/v2` مطابق لما يعلنه الـgateway.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

const waitFor = (c: ClientSocket, ev: string, ms = 2500) =>
  new Promise<unknown>((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(ev, (p: unknown) => { clearTimeout(t); res(p); });
  });

async function main() {
  const mini = new MiniRedis();
  const port = await mini.start();
  const url = `redis://127.0.0.1:${port}`;
  const conns: Redis[] = [];
  const mk = () => { const r = new Redis(url); r.on('error', () => undefined); conns.push(r); return r; };

  // حاوية API واحدة بالمحوّل، تمثّل الطرف المستقبِل
  const pub = mk(), sub = mk();
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  io.adapter(createAdapter(pub, sub));
  io.of('/v2').on('connection', (s) => {
    void s.join(`driver:${s.handshake.auth.userId}`);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const p = (httpServer.address() as { port: number }).port;

  const client = ioClient(`http://127.0.0.1:${p}/v2`, {
    auth: { userId: 'd1' }, transports: ['websocket'], reconnection: false,
  });
  await new Promise<void>((res, rej) => {
    client.on('connect', () => res());
    client.on('connect_error', rej);
  });
  await new Promise((r) => setTimeout(r, 200));

  // ---- دور العامل: لا خادم، فالباعث فوق Redis هو الوجهة ----
  console.log('RealtimeEmitter في دور العامل (server = undefined):');
  const emitter = new RealtimeEmitter(mk());
  const a = waitFor(client, 'offer:new');
  emitter.to(undefined, 'driver:d1').emit('offer:new', { offerId: 'w1' });
  const gotA = (await a) as { offerId?: string } | null;
  check('البثّ بلا خادم يصل العميل عبر Redis', gotA?.offerId === 'w1',
        gotA === null ? 'لم يصل — سقط بصمت' : JSON.stringify(gotA));

  // ---- دور الـAPI: الخادم موجود، فالبثّ محلي ----
  console.log('\nRealtimeEmitter في دور الـAPI (server موجود):');
  const b = waitFor(client, 'offer:closed');
  emitter.to(io.of('/v2') as unknown as never, 'driver:d1')
    .emit('offer:closed', { result: 'EXPIRED' });
  const gotB = (await b) as { result?: string } | null;
  check('البثّ بخادم محلي يصل العميل', gotB?.result === 'EXPIRED',
        gotB === null ? 'لم يصل' : JSON.stringify(gotB));

  // ---- غرفة خاطئة لا تصل ----
  const c2 = await (async () => {
    const w = waitFor(client, 'offer:new', 700);
    emitter.to(undefined, 'driver:someone-else').emit('offer:new', { offerId: 'x' });
    return w;
  })();
  check('غرفة سائق آخر لا تصل هذا العميل', c2 === null);

  console.log(`\n${pass} نجح، ${fail} فشل`);

  client.close();
  for (const r of conns) r.disconnect();
  io.close();
  httpServer.close();
  await mini.stop();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
