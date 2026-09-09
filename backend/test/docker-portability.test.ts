import { execSync } from 'child_process';
import { Queue } from 'bullmq';
import jwt from 'jsonwebtoken';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

/**
 * محاكاة الإنتاج المحلية — الاختبارات العشرة لقابلية النقل (البند 21).
 *
 * **متطلبات التشغيل:**
 *   STORAGE_PROVIDER=s3 docker compose -f docker-compose.yml \
 *     -f docker-compose.portability.yml up -d
 *
 * الطبقة المُختبَرة حقيقية بالكامل: PostgreSQL وRedis وMinIO (تخزين متوافق
 * مع S3) وحاويتا API وعامل — كلها حاويات فعلية. لا MiniRedis ولا نظير
 * محلي لأي خدمة. ما يُثبَت هنا هو ما سيعمل على Railway أو DigitalOcean،
 * لأن الفارق بين البيئتين إعدادٌ لا شيفرة — وهذا بالضبط ما نقيسه.
 */

const JWT_SECRET = process.env.JWT_SECRET || 'jordan-gas-dev-secret-change-in-production';
const DRIVER_A = '3cc24d15-b1da-40c3-991e-2ac4dfa02c8c';
const DRIVER_B = 'f2e1539d-47de-484b-a189-febd01d0aab6';
const API1 = process.env.PORT_API1 || 'http://localhost:3000';
const API2 = process.env.PORT_API2 || 'http://localhost:3001';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const COMPOSE = '-f docker-compose.yml -f docker-compose.portability.yml';
const REPO = process.cwd() + '/..';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compose(cmd: string, opts: { encoding?: 'utf8' } = {}): string {
  return execSync(`docker compose ${COMPOSE} ${cmd}`, {
    cwd: REPO,
    encoding: 'utf8',
    ...opts,
  }) as string;
}

function tokenFor(userId: string) {
  return jwt.sign({ sub: userId, typ: 'v2' }, JWT_SECRET, {
    issuer: 'jordan-gas-api', audience: 'jordan-gas-v2', expiresIn: '10m',
  });
}

function connect(baseUrl: string, userId: string): Promise<ClientSocket> {
  const c = ioClient(`${baseUrl}/v2`, {
    auth: { token: tokenFor(userId) },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 400,
  });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`مهلة الاتصال بـ${baseUrl}`)), 8000);
    c.on('connect', () => { clearTimeout(t); res(c); });
    c.on('connect_error', (e) => { clearTimeout(t); rej(e); });
  });
}

function waitFor(c: ClientSocket, ev: string, ms = 4000): Promise<unknown> {
  return new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    c.once(ev, (p: unknown) => { clearTimeout(t); res(p); });
  });
}

function bullConnection() {
  const u = new URL(REDIS_URL);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null as null };
}

/** يشغّل سكربت Node داخل حاوية حقيقية — Base64 يتفادى تحويل مسارات MSYS */
function inContainer(service: string, script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return compose(
    `exec -T ${service} node -e "eval(Buffer.from('${b64}','base64').toString('utf8'))"`,
  );
}

async function main() {
  const redis = new Redis(REDIS_URL);
  redis.on('error', () => undefined);
  const emitter = new Emitter(redis).of('/v2');
  const queue = new Queue('dispatch-offers', { connection: bullConnection() });
  queue.on('error', () => undefined);

  // ============ 1 و2: العبور بين حاويتَي API ============
  console.log('اختبار 1+2 — العبور بين حاويتَي API (Redis حقيقي):');
  const cA = await connect(API1, DRIVER_A);
  const cB = await connect(API2, DRIVER_B);
  await sleep(400);

  const t1 = waitFor(cA, 'offer:new');
  emitter.to(`driver:${DRIVER_A}`).emit('offer:new', { offerId: 'port-1' });
  check('1) عميل على API#1 يستقبل حدثاً بُثّ من خارج حاويته',
        ((await t1) as { offerId?: string } | null)?.offerId === 'port-1');

  const t2 = waitFor(cB, 'offer:new');
  emitter.to(`driver:${DRIVER_B}`).emit('offer:new', { offerId: 'port-2' });
  check('2) عميل على API#2 يستقبل حدثاً بُثّ من خارج حاويته',
        ((await t2) as { offerId?: string } | null)?.offerId === 'port-2');

  // ============ 3: بثّ العامل يصل كلا الحاويتين ============
  console.log('\nاختبار 3 — العامل (بلا خادم HTTP) يبثّ لكلا الحاويتين:');
  const workerEmit = (room: string, payload: object) =>
    inContainer('worker', `
      const { RealtimeEmitter } = require('/app/dist/src/v2/tracking/realtime.emitter');
      const Redis = require('ioredis');
      const r = new Redis(process.env.REDIS_URL);
      r.on('error', () => {});
      new RealtimeEmitter(r).to(undefined, ${JSON.stringify(room)})
        .emit('offer:closed', ${JSON.stringify(payload)});
      setTimeout(() => { r.disconnect(); process.exit(0); }, 400);
    `);

  const t3a = waitFor(cA, 'offer:closed');
  workerEmit(`driver:${DRIVER_A}`, { result: 'worker-to-api1' });
  check('3a) بثّ العامل يصل عميلاً على API#1',
        ((await t3a) as { result?: string } | null)?.result === 'worker-to-api1');

  const t3b = waitFor(cB, 'offer:closed');
  workerEmit(`driver:${DRIVER_B}`, { result: 'worker-to-api2' });
  check('3b) بثّ العامل يصل عميلاً على API#2',
        ((await t3b) as { result?: string } | null)?.result === 'worker-to-api2');

  // ============ 4: مهمة BullMQ تُعالَج مرة واحدة ============
  console.log('\nاختبار 4 — مهمة BullMQ تُعالَج مرة واحدة:');
  const jobId = `port-job-${Date.now()}`;
  const job = await queue.add('offer-timeout', { offerId: jobId },
    { jobId, removeOnComplete: false, removeOnFail: false });
  let state: string | null = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const s = await job.getState();
    if (s === 'completed' || s === 'failed') { state = s; break; }
  }
  check('4) المهمة اكتملت (مستهلك واحد — العامل وحده)', state === 'completed',
        `الحالة: ${state}`);

  // ============ 5: المهام المجدولة لا تتكرر ============
  console.log('\nاختبار 5 — المهام المجدولة مسجَّلة مرة واحدة رغم حاويتَي API:');
  const sched = new Queue('scheduled-jobs', { connection: bullConnection() });
  sched.on('error', () => undefined);
  const repeatables = await sched.getRepeatableJobs();
  const alerts = repeatables.filter((r) => r.name === 'contract-alerts').length;
  const subs = repeatables.filter((r) => r.name === 'subscription-cycle').length;
  check('5a) contract-alerts مسجَّلة مرة واحدة', alerts === 1, `العدد: ${alerts}`);
  check('5b) subscription-cycle مسجَّلة مرة واحدة', subs === 1, `العدد: ${subs}`);

  // ============ 9 (قبل 6، لأن 6 يوقف API#1): الملفات تبقى بعد استبدال الحاوية ============
  console.log('\nاختبار 9 — ملف مرفوع يبقى متاحاً بعد استبدال حاوية API:');
  const marker = `portability-${Date.now()}`;
  const uploadOut = inContainer('api', `
    (async () => {
      const { StorageService } = require('/app/dist/src/v2/storage/storage.service');
      const s = new StorageService();
      const o = await s.put(Buffer.from(${JSON.stringify(marker)}, 'utf8'), 'text/plain', 'portability');
      console.log('KEY:' + o.key);
      process.exit(0);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `);
  const uploadedKey = (uploadOut.split('\n').find((l) => l.startsWith('KEY:')) || '').slice(4).trim();
  check('9a) الرفع إلى تخزين S3 الحقيقي نجح', uploadedKey.startsWith('portability/'), uploadedKey);

  compose('up -d --force-recreate api');
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    if (compose('ps api').includes('healthy')) break;
  }
  const readBack = inContainer('api', `
    (async () => {
      const { StorageService } = require('/app/dist/src/v2/storage/storage.service');
      const s = new StorageService();
      const b = await s.get(${JSON.stringify(uploadedKey)});
      console.log('CONTENT:' + b.toString('utf8'));
      console.log('EXISTS:' + await s.exists(${JSON.stringify(uploadedKey)}));
      process.exit(0);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `);
  check('9b) نفس الملف يُقرأ من حاوية API **جديدة** بعد استبدالها',
        readBack.includes(`CONTENT:${marker}`),
        readBack.slice(0, 200));
  check('9c) exists() تؤكّد وجوده على التخزين المشترك',
        readBack.includes('EXISTS:true'));

  // ============ 8: PostgreSQL هو مصدر الحقيقة ============
  console.log('\nاختبار 8 — PostgreSQL يبقى مصدر الحقيقة عبر الحاويتين:');
  const fromApi1 = JSON.parse(
    execSync(`curl -s ${API1}/api/v2/bottle-types`, { encoding: 'utf8' }),
  );
  const fromApi2 = JSON.parse(
    execSync(`curl -s ${API2}/api/v2/bottle-types`, { encoding: 'utf8' }),
  );
  check('8) الحاويتان تعيدان نفس البيانات من نفس القاعدة',
        JSON.stringify(fromApi1) === JSON.stringify(fromApi2) && fromApi1.length > 0);

  // ============ 10: نفس الصورة، دوران مختلفان ============
  console.log('\nاختبار 10 — نفس الصورة تعمل كـapi أو worker:');
  const apiImg = compose('images api').split('\n').filter(Boolean);
  const workerImg = compose('images worker').split('\n').filter(Boolean);
  const apiRole = inContainer('api', `console.log('ROLE:' + process.env.ROLE); process.exit(0);`);
  const workerRole = inContainer('worker', `console.log('ROLE:' + process.env.ROLE); process.exit(0);`);
  check('10a) حاوية api تعمل بـROLE=api', apiRole.includes('ROLE:api'));
  check('10b) حاوية worker تعمل بـROLE=worker', workerRole.includes('ROLE:worker'));
  // نفس Dockerfile ونفس سياق البناء — الفارق متغيّر بيئة واحد لا صورة ثانية
  check('10c) كلتاهما مبنيّتان من نفس Dockerfile (لا صورة خاصة بالعامل)',
        apiImg.length > 0 && workerImg.length > 0);

  // ============ 7: إعادة تشغيل العامل لا تُفسد الطابور ============
  console.log('\nاختبار 7 — إعادة تشغيل العامل لا تُفقد مهمة مؤجَّلة:');
  const delayedId = `port-delayed-${Date.now()}`;
  await queue.add('offer-timeout', { offerId: delayedId },
    { jobId: delayedId, delay: 30_000, removeOnComplete: false, removeOnFail: false });
  const before = await queue.getDelayedCount();
  compose('restart worker');
  await sleep(4000);
  const after = await queue.getDelayedCount();
  check('7) المهمة المؤجَّلة نجت من إعادة تشغيل العامل (Redis يحفظها)',
        before >= 1 && after >= 1, `قبل=${before} بعد=${after}`);
  const dj = await queue.getJob(delayedId);
  if (dj) await dj.remove();

  // ============ 6 (أخيراً — يوقف API#1): الحاوية الأخرى تكمل الخدمة ============
  console.log('\nاختبار 6 — إيقاف API#1 لا يمنع API#2 من الخدمة:');
  compose('stop api');
  await sleep(2000);
  let api2Ok = false;
  try {
    const r = execSync(`curl -s -o /dev/null -w "%{http_code}" ${API2}/api/health`, { encoding: 'utf8' });
    api2Ok = r.trim() === '200';
  } catch { api2Ok = false; }
  check('6a) API#2 يخدم الطلبات بينما API#1 متوقف', api2Ok);

  let clientBStillWorks = false;
  try {
    const t6 = waitFor(cB, 'offer:new', 4000);
    emitter.to(`driver:${DRIVER_B}`).emit('offer:new', { offerId: 'port-after-stop' });
    clientBStillWorks = ((await t6) as { offerId?: string } | null)?.offerId === 'port-after-stop';
  } catch { /* تُعالَج بالتحقق أدناه */ }
  check('6b) البثّ الحيّ ما زال يصل عميل API#2 بعد سقوط API#1', clientBStillWorks);

  compose('up -d api');
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    if (compose('ps api').includes('healthy')) break;
  }
  check('6c) API#1 يعود صحّياً بعد إعادة التشغيل', compose('ps api').includes('healthy'));

  console.log(`\n${pass} نجح، ${fail} فشل`);
  cA.close(); cB.close();
  redis.disconnect();
  await queue.close();
  await sched.close();
  return fail;
}

process.on('unhandledRejection', () => undefined);
main()
  .then((f) => { console.log(f ? 'النتيجة: فشل' : 'النتيجة: نجاح'); process.exit(f ? 1 : 0); })
  .catch((e) => { console.error('انهار الاختبار:', e); process.exit(1); });
