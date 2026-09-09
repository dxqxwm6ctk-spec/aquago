import jwt from 'jsonwebtoken';
import { execSync } from 'child_process';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * المرحلة 3.5 — يثبّت أن العامل (حاوية Docker حقيقية بلا خادم HTTP) يبثّ
 * فعلياً إلى عملاء موصولين بأيّ من حاويتَي API، باستدعاء RealtimeEmitter
 * **المُصرَّف فعلياً داخل حاوية العامل نفسها** عبر `docker compose exec` —
 * لا نظير محلي، ولا استيراد من dist المحلي: الكود الذي يعمل هو الكود
 * الذي يُشحَن فعلاً في صورة العامل.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'jordan-gas-dev-secret-change-in-production';
const DRIVER_A = '3cc24d15-b1da-40c3-991e-2ac4dfa02c8c';
const API1_URL = process.env.PHASE3_API1_URL || 'http://localhost:3000';
const API2_URL = process.env.PHASE3_API2_URL || 'http://localhost:3001';

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
function connect(baseUrl: string, userId: string): Promise<ClientSocket> {
  const c = ioClient(`${baseUrl}/v2`, {
    auth: { token: tokenFor(userId) }, transports: ['websocket'],
  });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), 6000);
    c.on('connect', () => { clearTimeout(t); res(c); });
    c.on('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}
function waitFor(c: ClientSocket, ev: string, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(ev, (p: unknown) => { clearTimeout(t); res(p); });
  });
}

/** يبثّ من داخل حاوية العامل الحقيقية عبر RealtimeEmitter المُصرَّف فعلياً */
function emitFromRealWorkerContainer(room: string, event: string, payload: object) {
  const script =
    `const { RealtimeEmitter } = require('/app/dist/src/v2/tracking/realtime.emitter');` +
    `const Redis = require('ioredis');` +
    `const redis = new Redis(process.env.REDIS_URL);` +
    `redis.on('error', () => {});` +
    `const emitter = new RealtimeEmitter(redis);` +
    `emitter.to(undefined, ${JSON.stringify(room)}).emit(${JSON.stringify(event)}, ${JSON.stringify(payload)});` +
    `setTimeout(() => { redis.disconnect(); process.exit(0); }, 400);`;
  execSync(`docker compose exec -T worker node -e "${script.replace(/"/g, '\\"')}"`, {
    cwd: process.cwd() + '/..',
    stdio: 'pipe',
  });
}

async function main() {
  console.log('عامل Docker حقيقي (RealtimeEmitter مُصرَّف فعلياً) → عميلَين على API#1 وAPI#2:\n');

  const clientOnApi1 = await connect(API1_URL, DRIVER_A);
  check('عميل موصول بـAPI#1', clientOnApi1.connected);
  await new Promise((r) => setTimeout(r, 300));

  const a = waitFor(clientOnApi1, 'offer:closed');
  emitFromRealWorkerContainer(`driver:${DRIVER_A}`, 'offer:closed', { result: 'from-real-worker' });
  const gotA = (await a) as { result?: string } | null;
  check('بثّ من حاوية العامل الحقيقية يصل عميلاً على API#1',
        gotA?.result === 'from-real-worker',
        gotA === null ? 'لم يصل' : JSON.stringify(gotA));

  clientOnApi1.close();

  const clientOnApi2 = await connect(API2_URL, DRIVER_A);
  await new Promise((r) => setTimeout(r, 300));
  const b = waitFor(clientOnApi2, 'offer:closed');
  emitFromRealWorkerContainer(`driver:${DRIVER_A}`, 'offer:closed', { result: 'from-real-worker-2' });
  const gotB = (await b) as { result?: string } | null;
  check('بثّ من حاوية العامل الحقيقية يصل عميلاً على API#2 (نفس المستخدم، حاوية أخرى)',
        gotB?.result === 'from-real-worker-2',
        gotB === null ? 'لم يصل' : JSON.stringify(gotB));

  console.log(`\n${pass} نجح، ${fail} فشل`);
  clientOnApi2.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
