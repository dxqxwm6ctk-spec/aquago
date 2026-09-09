import { execSync } from 'child_process';
import jwt from 'jsonwebtoken';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * المرحلة 3.5 — إعادة الاتصال بعد إعادة تشغيل حاوية API فعلياً على Docker.
 * `docker compose restart api` حقيقية — لا محاكاة قطع اتصال داخل العملية.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'jordan-gas-dev-secret-change-in-production';
const DRIVER_A = '3cc24d15-b1da-40c3-991e-2ac4dfa02c8c';
const API1_URL = process.env.PHASE3_API1_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function tokenFor(userId: string) {
  return jwt.sign({ sub: userId, typ: 'v2' }, JWT_SECRET, {
    issuer: 'jordan-gas-api', audience: 'jordan-gas-v2', expiresIn: '5m',
  });
}

async function main() {
  console.log(`إعادة تشغيل حاوية API حقيقية على Docker (${API1_URL}):\n`);

  const socket: ClientSocket = ioClient(`${API1_URL}/v2`, {
    auth: { token: tokenFor(DRIVER_A) },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
  });

  const connected = await new Promise<boolean>((res) => {
    socket.on('connect', () => res(true));
    socket.on('connect_error', () => res(false));
    setTimeout(() => res(false), 6000);
  });
  check('الاتصال الأولي ينجح', connected);

  let disconnectSeen = false;
  socket.on('disconnect', () => { disconnectSeen = true; });

  // 'reconnect' من socket.io-client يصدر خصيصاً عند نجاح إعادة الاتصال
  // التلقائي — يميّزه عن 'connect' الذي يصدر أيضاً عند الاتصال الأول.
  const reconnectPromise = new Promise<boolean>((res) => {
    socket.io.on('reconnect', () => res(true));
    setTimeout(() => res(false), 25000);
  });

  console.log('\nإعادة تشغيل حاوية jordan_gas_api فعلياً (docker compose restart)...');
  execSync('docker compose restart api', {
    cwd: process.cwd() + '/..',
    stdio: 'pipe',
  });

  const reconnected = await reconnectPromise;

  check('انقطاع فعلي رُصد أثناء إعادة تشغيل الحاوية', disconnectSeen);
  check('إعادة الاتصال التلقائية تنجح بعد أن تعود الحاوية (حدث reconnect)', reconnected);

  // بعد إعادة الاتصال، هل استؤنفت عضوية الغرفة (المصادقة الجديدة، الجلسة نفسها)؟
  if (reconnected) {
    await new Promise((r) => setTimeout(r, 500));
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    redis.on('error', () => undefined);
    const emitter = new Emitter(redis).of('/v2');

    const gotEvent = new Promise((res) => {
      const t = setTimeout(() => res(null), 5000);
      socket.once('offer:new', (p: unknown) => { clearTimeout(t); res(p); });
    });
    emitter.to(`driver:${DRIVER_A}`).emit('offer:new', { offerId: 'after-reconnect' });
    const got = (await gotEvent) as { offerId?: string } | null;
    check('بعد إعادة الاتصال — عضوية الغرفة استُؤنفت وتصل الأحداث من جديد',
          got?.offerId === 'after-reconnect',
          got === null ? 'لم يصل الحدث بعد إعادة الاتصال' : JSON.stringify(got));
    redis.disconnect();
  } else {
    fail++;
    console.log('  FAIL تخطّي فحص استئناف الغرفة — إعادة الاتصال فشلت');
  }

  console.log(`\n${pass} نجح، ${fail} فشل`);
  socket.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
