import http from 'http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * يثبّت إصلاح لوحة الأدمن (`backend/public/admin/index.html`): الانتقال من
 * `io({ auth: { token } })` (تعتمد ترتيب النقل الافتراضي — استطلاع HTTP
 * أولاً ثم ترقية) إلى `io({ transports: ['websocket'], auth: { token } })`.
 *
 * الاختبار يُعيد بناء `TrackingGateway.handleConnection` بحرفيّته (JWT من
 * handshake.auth.token، عضوية غرفة 'admin' لدور ADMIN) على خادم حقيقي،
 * ويتصل بعميل حقيقي بنفس نمط اتصال لوحة الأدمن الجديد — لا نظيراً مصطنعاً
 * للمنطق، بل الشرط الفعلي الذي يتحقق منه الخادم.
 *
 * الهدف: إثبات أن تثبيت النقل على websocket فقط لم يكسر المصادقة ولا
 * عضوية الغرفة ولا استقبال الأحداث ولا إعادة الاتصال — التغيير في خيارات
 * اتصال العميل وحدها، ولا شيء خادميّ يعتمد على نوع النقل.
 */

const JWT_SECRET = 'test-secret-admin-socket';
let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const waitFor = (c: ClientSocket, ev: string, ms = 2000) =>
  new Promise<unknown>((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(ev, (p: unknown) => { clearTimeout(t); res(p); });
  });

/** نفس منطق handleConnection في TrackingGateway حرفياً — لا تبسيط */
function wireGatewayLogic(io: Server) {
  io.on('connection', (client) => {
    const token =
      (client.handshake.auth as { token?: string } | undefined)?.token ||
      (client.handshake.headers.authorization?.startsWith('Bearer ')
        ? client.handshake.headers.authorization.slice(7)
        : undefined);
    if (!token) return client.disconnect(true);
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { sub: string; role: string };
      client.data.user = { id: payload.sub, role: payload.role };
      if (payload.role === 'DRIVER') void client.join('drivers');
      if (payload.role === 'ADMIN' || payload.role === 'FINANCE') void client.join('admin');
    } catch {
      client.disconnect(true);
    }
  });
}

async function main() {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  wireGatewayLogic(io);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as { port: number }).port;

  const adminToken = jwt.sign({ sub: 'admin-1', role: 'ADMIN' }, JWT_SECRET);

  // ---- 1) نمط الاتصال الجديد بحرفيته: websocket فقط + auth.token ----
  console.log('اتصال لوحة الأدمن بالنمط الجديد (websocket فقط):');
  const client = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { token: adminToken },
    reconnection: true,
  });
  const connected = await new Promise<boolean>((res) => {
    client.on('connect', () => res(true));
    client.on('connect_error', () => res(false));
    setTimeout(() => res(false), 3000);
  });
  check('الاتصال ينجح بـtransports: [websocket] فقط', connected);
  check(
    'النقل الفعلي المستخدم هو websocket لا polling',
    client.io.engine.transport.name === 'websocket',
  );

  // ---- 2) عضوية غرفة admin — إثبات أن المصادقة تمّت فعلاً ----
  const a = waitFor(client, 'order:new');
  io.to('admin').emit('order:new', { id: 'ord-1' });
  const gotOrderNew = await a;
  check('عضو غرفة admin يستقبل order:new (يثبت انضمام الغرفة نجح)', gotOrderNew !== null);

  const b = waitFor(client, 'driver:location');
  io.to('admin').emit('driver:location', { driverId: 'd1', lat: 31.9, lng: 35.9 });
  const gotLocation = await b;
  check('عضو غرفة admin يستقبل driver:location', gotLocation !== null);

  // ---- 3) توكن غير صالح لا يزال يُرفض (لم يغيّر النقل سلوك المصادقة) ----
  console.log('\nالمصادقة لا تزال تُرفض بلا توكن صالح:');
  const badClient = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { token: 'garbage-not-a-jwt' },
    reconnection: false,
  });
  // 'connect' يصل فور اكتمال مصافحة النقل — قبل أن يعالج الخادم رفض
  // التوكن ويُصدر القطع. الحكم الصحيح إذاً هو الحالة النهائية بعد مهلة
  // كافية: هل استقرّ العميل مقطوعاً؟ لا سباق مع أول حدث يصل.
  let sawDisconnect = false;
  badClient.on('disconnect', () => { sawDisconnect = true; });
  await new Promise((r) => setTimeout(r, 1500));
  check('توكن غير صالح يُقطع (لا يبقى متصلاً)',
        sawDisconnect && !badClient.connected,
        `disconnect event: ${sawDisconnect}, connected: ${badClient.connected}`);
  badClient.close();

  // ---- 4) دور غير مخوَّل (زبون عادي) لا ينضم لغرفة admin ----
  console.log('\nدور بلا صلاحية admin لا يرى بثّ اللوحة:');
  const customerToken = jwt.sign({ sub: 'cust-1', role: 'CUSTOMER' }, JWT_SECRET);
  const customerClient = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    auth: { token: customerToken },
    reconnection: false,
  });
  await new Promise<void>((res) => customerClient.on('connect', () => res()));
  const c = await waitFor(customerClient, 'order:new', 700);
  io.to('admin').emit('order:new', { id: 'ord-2' });
  const gotAsCustomer = await waitFor(customerClient, 'order:new', 700);
  check('زبون عادي لا يستقبل بثّ غرفة admin', gotAsCustomer === null, JSON.stringify(c));

  // ---- 5) إعادة الاتصال بعد قطع الشبكة تُعيد المصادقة والغرفة ----
  console.log('\nإعادة الاتصال بعد قطع:');
  client.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  client.connect();
  const reconnected = await new Promise<boolean>((res) => {
    client.once('connect', () => res(true));
    setTimeout(() => res(false), 3000);
  });
  check('العميل يعيد الاتصال يدوياً بنفس الإعدادات', reconnected);

  if (reconnected) {
    await new Promise((r) => setTimeout(r, 150)); // انضمام الغرفة يقع بعد 'connect' على الخادم
    const d = waitFor(client, 'order:new');
    io.to('admin').emit('order:new', { id: 'ord-3' });
    const gotAfterReconnect = await d;
    check('بعد إعادة الاتصال — عضوية admin وبثّ الأحداث يعملان من جديد',
          gotAfterReconnect !== null);
  } else {
    fail++;
    console.log('  FAIL تخطّي فحص ما بعد إعادة الاتصال — الاتصال الأول فشل');
  }

  console.log(`\n${pass} نجح، ${fail} فشل`);

  client.close();
  customerClient.close();
  io.close();
  httpServer.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
