/**
 * طبقة المراقبة — منطق محض بلا شبكة ولا Docker.
 *
 * ما يُثبَت هنا هو ما ينكسر صامتاً في الإنتاج: صيغة سطر السجلّ التي
 * يعتمد عليها المجمّع، وتعقيم المسارات الذي يمنع انفجار الأبعاد، وأن
 * المقاييس تُغلق بلا توكن.
 */
import { AllExceptionsFilter } from '../src/v2/observability/all-exceptions.filter';
import { JsonLogger } from '../src/v2/observability/json-logger';
import {
  bindJobMetrics,
  instrumentJobOutcomes,
  resetJobMetrics,
} from '../src/v2/observability/job-metrics';
import { MetricsController } from '../src/v2/observability/metrics.controller';
import { MetricsMiddleware } from '../src/v2/observability/metrics.middleware';
import { MetricsService } from '../src/v2/observability/metrics.service';
import { QueueDepthService } from '../src/v2/observability/queue-depth.service';
import { RequestLoggingInterceptor } from '../src/v2/observability/request-logging.interceptor';

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  let result: T;
  try { result = fn(); }
  catch (e) { restore(); throw e; }
  // دالة غير متزامنة: `finally` المتزامن يستعيد البيئة قبل أن ينتهي
  // العمل داخلها، فيقرأ الفحص متغيّراً أُعيد أصلاً. الاستعادة تتبع الوعد.
  if (result instanceof Promise) {
    return result.finally(restore) as unknown as T;
  }
  restore();
  return result;
}

/** يلتقط ما كُتب على stdout/stderr أثناء تنفيذ الدالة */
function captureOutput(fn: () => void): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as NodeJS.WriteStream).write = ((c: string) => { out.push(String(c)); return true; }) as never;
  (process.stderr as NodeJS.WriteStream).write = ((c: string) => { err.push(String(c)); return true; }) as never;
  try { fn(); } finally {
    (process.stdout as NodeJS.WriteStream).write = so;
    (process.stderr as NodeJS.WriteStream).write = se;
  }
  return { out, err };
}

// ————————————————————————————————— JsonLogger

function testLogger() {
  console.log('\n— JsonLogger —');

  withEnv({ LOG_FORMAT: 'json', ROLE: 'worker' }, () => {
    const logger = new JsonLogger();
    const { out, err } = captureOutput(() => {
      logger.log('مرحباً', 'TestCtx');
      logger.error('انفجار', 'at foo()', 'TestCtx');
    });

    check('سطر السجّل JSON صالح', out.length === 1 && (() => {
      try { JSON.parse(out[0]); return true; } catch { return false; }
    })());

    const line = JSON.parse(out[0]);
    check('يحمل level', line.level === 'log', JSON.stringify(line));
    check('يحمل role من البيئة', line.role === 'worker', line.role);
    check('يحمل context', line.context === 'TestCtx');
    check('يحمل msg', line.msg === 'مرحباً');
    check('ts بصيغة ISO', typeof line.ts === 'string' && line.ts.endsWith('Z'));

    check('الخطأ إلى stderr لا stdout', err.length === 1 && out.length === 1);
    const e = JSON.parse(err[0]);
    check('الخطأ يحمل المكدّس', e.stack === 'at foo()' && e.level === 'error');
  });

  // بلا ANSI: هذا هو سبب وجود الصنف أصلاً
  withEnv({ LOG_FORMAT: 'json' }, () => {
    const { out } = captureOutput(() => new JsonLogger().log('x', 'C'));
    check('بلا محارف ANSI', !/\x1b\[/.test(out[0]), JSON.stringify(out[0]));
  });

  // النصّ البشري في التطوير
  withEnv({ LOG_FORMAT: 'text', NODE_ENV: 'development' }, () => {
    const { out } = captureOutput(() => new JsonLogger().log('بشري', 'C'));
    const joined = out.join('');
    check('LOG_FORMAT=text يبقى بشرياً', joined.includes('بشري') && !joined.trimStart().startsWith('{'));
  });

  // الافتراض في الإنتاج JSON بلا إعداد
  withEnv({ LOG_FORMAT: undefined, NODE_ENV: 'production' }, () => {
    const { out } = captureOutput(() => new JsonLogger().log('p', 'C'));
    check('الإنتاج JSON افتراضياً', out[0].trimStart().startsWith('{'));
  });

  withEnv({ LOG_LEVEL: 'warn' }, () => {
    const lv = JsonLogger.levels();
    check('LOG_LEVEL=warn يُسكت log/debug', !lv.includes('log') && lv.includes('warn') && lv.includes('error'));
  });
  withEnv({ LOG_LEVEL: undefined }, () => {
    const lv = JsonLogger.levels();
    check('الافتراضي يشمل log ولا يشمل debug', lv.includes('log') && !lv.includes('debug'));
  });

  // كائن دوري يجب ألا يُسقط السطر
  withEnv({ LOG_FORMAT: 'json' }, () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let threw = false;
    const { out } = captureOutput(() => {
      try { new JsonLogger().log(circular as unknown as string, 'C'); }
      catch { threw = true; }
    });
    check('كائن دوري لا يرمي', !threw && out.length === 1);
  });
}

// ————————————————————————————————— MetricsService

function testMetrics() {
  console.log('\n— MetricsService —');
  const m = new MetricsService();

  m.recordRequest('GET', '/api/v2/orders/:id', 200, 30);
  m.recordRequest('GET', '/api/v2/orders/:id', 200, 70);
  m.recordRequest('GET', '/api/v2/orders/:id', 500, 10);
  m.recordRequest('POST', '/api/v2/orders', 201, 5);

  const text = m.render();
  check('صيغة Prometheus فيها HELP وTYPE',
    text.includes('# HELP aquago_http_requests_total') && text.includes('# TYPE aquago_http_requests_total counter'));
  check('يفصل 2xx عن 5xx',
    text.includes('status="2xx"} 2') && text.includes('status="5xx"} 1'), text);
  check('المتوسط محسوب على كل الطلبات',
    text.includes('aquago_http_duration_ms_avg{role="api",route="/api/v2/orders/:id"} 36.7'), text);
  check('الأقصى مسجَّل', text.includes('aquago_http_duration_ms_max{role="api",route="/api/v2/orders/:id"} 70'));

  m.recordJob('dispatch-offers', 'completed');
  m.recordJob('dispatch-offers', 'failed');
  m.recordJob('dispatch-offers', 'failed');
  const t2 = m.render();
  check('عدّاد المهام بحسب النتيجة',
    t2.includes('queue="dispatch-offers",outcome="failed"} 2') &&
    t2.includes('queue="dispatch-offers",outcome="completed"} 1'), t2);

  const snap = m.snapshot();
  check('اللقطة تحمل زمن التشغيل', typeof snap.uptimeSeconds === 'number');
  check('اللقطة تحمل الزمن لكل مسار', snap.latencyByRoute['/api/v2/orders/:id'].count === 3);

  // الاقتباس داخل اسم مسار يكسر صيغة Prometheus إن لم يُهرَّب
  const m2 = new MetricsService();
  m2.recordRequest('GET', '/api/a"b', 200, 1);
  check('الاقتباس مهرَّب', m2.render().includes('route="/api/a\\"b"'), m2.render());

  // كل سطر غير تعليقي يجب أن يطابق شكل Prometheus
  const bad = m.render().split('\n').filter((l) => l && !l.startsWith('#'))
    .filter((l) => !/^[a-z_]+\{[^}]*\}\s[\d.]+$/.test(l));
  check('كل الأسطر تطابق صيغة Prometheus', bad.length === 0, bad.join(' | '));
}

// ————————————————————————————————— المعترض: تعقيم المسار

/** استجابة وهمية تُطلق `finish` عند الاستدعاء — كما يفعل Express */
function fakeRes(statusCode: number) {
  const listeners: Array<() => void> = [];
  return {
    statusCode,
    once(ev: string, h: () => void) { if (ev === 'finish') listeners.push(h); },
    finish() { listeners.forEach((h) => h()); },
  };
}

function testMiddleware() {
  console.log('\n— MetricsMiddleware (العدّ) —');
  const req = (path: string, route?: string) => ({
    method: 'GET',
    path,
    baseUrl: '',
    ...(route ? { route: { path: route } } : {}),
  });

  const run = (m: MetricsService, path: string, status: number, route?: string) => {
    const mw = new MetricsMiddleware(m);
    const res = fakeRes(status);
    mw.use(req(path, route) as never, res as never, () => undefined);
    res.finish();
  };

  // **الثغرة التي قاسها التشغيل الحيّ**: Nest يشغّل الحرّاس قبل المعترضات،
  // فطلب يرفضه الحارس بـ401 لا يبلغ المعترض. الوسيطة تسبق الحارس فتراه.
  const mGuard = new MetricsService();
  run(mGuard, '/api/v2/orders/8f3c1d2e-aaaa-bbbb-cccc-ddddeeeeffff', 401);
  run(mGuard, '/api/v2/orders/999888777', 401);
  const guardText = mGuard.render();
  check('الطلب المرفوض من الحارس يُعدّ',
    guardText.includes('route="/api/v2/orders/:id",status="4xx"} 2'), guardText);

  // النمط المتوفّر يُستعمل كما هو
  const m1 = new MetricsService();
  run(m1, '/api/v2/orders/8f3c1d2e-aaaa-bbbb-cccc-ddddeeeeffff', 200, '/api/v2/orders/:id');
  check('نمط Nest يُستعمل كما هو',
    Object.keys(m1.snapshot().latencyByRoute)[0] === '/api/v2/orders/:id');

  // بلا نمط (رفض مبكر أو 404) يُعقَّم المسار
  const m2 = new MetricsService();
  run(m2, '/api/v2/orders/8f3c1d2e-aaaa-bbbb-cccc-ddddeeeeffff', 404);
  run(m2, '/api/v2/orders/123456', 404);
  run(m2, '/api/v2/orders/clx9a8b7c6d5e4f3g2h1i0jk', 404);
  const routes = Object.keys(m2.snapshot().latencyByRoute);
  check('uuid ورقم وcuid كلها تصير :id',
    routes.length === 1 && routes[0] === '/api/v2/orders/:id', routes.join(', '));

  // الحارس الحقيقي ضد انفجار الأبعاد: ألف معرّف مختلف = سلسلة واحدة
  const m3 = new MetricsService();
  for (let n = 0; n < 1000; n++) run(m3, `/api/v2/orders/${n}`, 404);
  check('ألف معرّف تنتج سلسلة مقاييس واحدة',
    Object.keys(m3.snapshot().latencyByRoute).length === 1,
    String(Object.keys(m3.snapshot().latencyByRoute).length));

  // مقطع ليس معرّفاً يجب ألّا يُعقَّم — وإلا اندمجت مسارات مختلفة
  const m4 = new MetricsService();
  run(m4, '/api/v2/orders/active', 200);
  run(m4, '/api/v2/orders/pending', 200);
  check('المقاطع الوصفية تبقى كما هي',
    Object.keys(m4.snapshot().latencyByRoute).length === 2,
    Object.keys(m4.snapshot().latencyByRoute).join(', '));

  // قطع العميل للاتصال ليس استجابة — `close` بلا `finish` لا يُعدّ
  const m5 = new MetricsService();
  const mw5 = new MetricsMiddleware(m5);
  mw5.use(req('/api/v2/x') as never, fakeRes(200) as never, () => undefined);
  check('بلا finish لا يُعدّ شيء', Object.keys(m5.snapshot().latencyByRoute).length === 0);
}

function testInterceptor() {
  console.log('\n— RequestLoggingInterceptor (السجلّ) —');
  const interceptor = new RequestLoggingInterceptor();
  const record = (
    interceptor as unknown as {
      record(ctx: unknown, req: unknown, status: number, started: number): void;
    }
  ).record.bind(interceptor);

  const ctx = { getType: () => 'http' };
  const req = (path: string) => ({ method: 'GET', path, baseUrl: '' });

  // فحص الصحّة الناجح صامت — وإلا أغرق الموازنُ السجلَّ
  const quiet = captureOutput(() =>
    withEnv({ LOG_FORMAT: 'json' }, () => {
      record(ctx, req('/api/health/live'), 200, Date.now());
      record(ctx, req('/api/health/ready'), 200, Date.now());
    }),
  );
  check('فحص الصحّة الناجح لا يُسجَّل', quiet.out.length === 0 && quiet.err.length === 0);

  // فشله يُسجَّل دائماً: هو ما نراقبه
  const loud = captureOutput(() =>
    withEnv({ LOG_FORMAT: 'json' }, () => record(ctx, req('/api/health/ready'), 503, Date.now())),
  );
  check('فشل فحص الصحّة يُسجَّل', loud.out.length + loud.err.length > 0);
}

// ————————————————————————————————— المرشّح

function testFilter() {
  console.log('\n— AllExceptionsFilter —');
  const filter = new AllExceptionsFilter();

  let sent: { status?: number; body?: unknown } = {};
  const host = (exception: unknown, headersSent = false) => ({
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => ({
        headersSent,
        status(s: number) { sent.status = s; return this; },
        json(b: unknown) { sent.body = b; return this; },
      }),
      getRequest: () => ({ method: 'GET', path: '/api/v2/x' }),
    }),
    _e: exception,
  });

  // خطأ غير متوقَّع: 500 برسالة عامة — لا تسريب لتفاصيل داخلية
  sent = {};
  const leaky = new Error('relation "public.LedgerEntry" does not exist at /app/src/db.ts:42');
  captureOutput(() => filter.catch(leaky, host(leaky) as never));
  check('الخطأ غير المتوقَّع يردّ 500', sent.status === 500);
  const body = JSON.stringify(sent.body);
  check('لا تسريب لاسم جدول أو مسار ملف',
    !body.includes('LedgerEntry') && !body.includes('/app/src'), body);
  check('رسالة عامة للعميل', body.includes('غير متوقَّع'), body);

  // التفاصيل يجب أن تصل السجلّ كاملة — وإلا صار التشخيص مستحيلاً
  const captured = captureOutput(() =>
    withEnv({ LOG_FORMAT: 'json' }, () => {
      // مسجّل Nest عالمي — نكتفي بالتحقق من عدم ابتلاع الاستثناء
      filter.catch(leaky, host(leaky) as never);
    }),
  );
  check('الاستثناء لا يُبتلع بصمت', captured.out.length + captured.err.length > 0);

  // استثناء Nest مقصود يمرّ برسالته
  sent = {};
  const { HttpException } = require('@nestjs/common') as typeof import('@nestjs/common');
  const intended = new HttpException('رقم الهاتف غير صالح', 400);
  captureOutput(() => filter.catch(intended, host(intended) as never));
  check('استثناء Nest المقصود يحفظ رمزه', sent.status === 400);
  check('رسالة المطوّر تصل العميل',
    JSON.stringify(sent.body).includes('رقم الهاتف غير صالح'), JSON.stringify(sent.body));

  // بدأ البثّ: الكتابة فوقه تُفسد الاستجابة
  sent = {};
  captureOutput(() => filter.catch(leaky, host(leaky, true) as never));
  check('لا يكتب فوق استجابة بدأ بثّها', sent.status === undefined);

  // سياق غير HTTP لا يرمي
  let threw = false;
  captureOutput(() => {
    try { filter.catch(leaky, { getType: () => 'ws' } as never); } catch { threw = true; }
  });
  check('سياق غير HTTP لا يرمي', !threw);
}

// ————————————————————————————————— عدّادات المهام

function testJobMetrics() {
  console.log('\n— job-metrics —');
  resetJobMetrics();

  type Handler = (job: unknown, err?: Error) => void;
  const handlers = new Map<string, Handler>();
  const fakeWorker = { on: (ev: string, h: Handler) => { handlers.set(ev, h); } };

  class DelayedError extends Error {}

  // قبل الربط: لا انهيار — العامل قد يُنشأ قبل تهيئة الوحدة
  instrumentJobOutcomes(fakeWorker as never, 'q1');
  let threw = false;
  try { handlers.get('completed')!({}); } catch { threw = true; }
  check('بلا ربط لا ينهار', !threw);

  const metrics = new MetricsService();
  bindJobMetrics(metrics);
  handlers.get('completed')!({});
  handlers.get('failed')!({}, new Error('boom'));
  const snap = metrics.snapshot();
  check('النجاح يُعدّ', snap.jobs['q1 completed'] === 1, JSON.stringify(snap.jobs));
  check('الفشل يُعدّ', snap.jobs['q1 failed'] === 1, JSON.stringify(snap.jobs));

  // التأجيل المقصود ليس فشلاً — وإلا اشتعل التنبيه من حملة تسير كما صُمّمت
  const h2 = new Map<string, Handler>();
  instrumentJobOutcomes(
    { on: (ev: string, h: Handler) => { h2.set(ev, h); } } as never,
    'aquago-whatsapp',
    (e) => e instanceof DelayedError,
  );
  h2.get('failed')!({}, new DelayedError('delayed'));
  h2.get('failed')!({}, new Error('حقيقي'));
  check('التأجيل المقصود لا يُعدّ فشلاً',
    metrics.snapshot().jobs['aquago-whatsapp failed'] === 1,
    JSON.stringify(metrics.snapshot().jobs));

  resetJobMetrics();
}

// ————————————————————————————————— حماية نقطة المقاييس

function testMetricsAuth() {
  console.log('\n— حماية /api/metrics —');
  const controller = new MetricsController(
    new MetricsService(),
    { render: async () => '', depths: async () => ({}) } as never,
  );
  const req = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} }) as never;

  const rejects = async (r: unknown): Promise<boolean> => {
    try { await controller.scrape(r as never); return false; } catch { return true; }
  };

  return (async () => {
    // بلا توكن معرَّف: مغلقة — لا تُفتح للجميع «مؤقتاً»
    await withEnv({ METRICS_TOKEN: undefined }, async (): Promise<void> => {
      check('بلا METRICS_TOKEN مغلقة', await rejects(req('Bearer x')));
    });

    await withEnv({ METRICS_TOKEN: 'سرّ-طويل-للاختبار' }, async () => {
      check('بلا ترويسة مرفوض', await rejects(req()));
      check('توكن خاطئ مرفوض', await rejects(req('Bearer خطأ')));
      check('توكن بطول مختلف مرفوض', await rejects(req('Bearer سرّ')));
      check('صيغة غير Bearer مرفوضة', await rejects(req('Basic سرّ-طويل-للاختبار')));
      const ok = await controller.scrape(req('Bearer سرّ-طويل-للاختبار'));
      check('التوكن الصحيح يُقبل', typeof ok === 'string' && ok.includes('aquago_uptime_seconds'));
    });
  })();
}

function testQueueDepthRole() {
  console.log('\n— QueueDepthService (بحسب الدور) —');
  // العامل بلا نقطة مقاييس — فتح اتصالات لا قارئ لها هدرٌ محض
  const worker = withEnv({ ROLE: 'worker' }, () => new QueueDepthService());
  const wq = (worker as unknown as { queues: Map<string, unknown> }).queues;
  check('العامل لا يفتح طوابير عمق', wq.size === 0, String(wq.size));

  const api = withEnv({ ROLE: 'api' }, () => new QueueDepthService());
  const aq = (api as unknown as { queues: Map<string, unknown> }).queues;
  check('الـAPI يفتح الطوابير الثلاثة', aq.size === 3, String(aq.size));

  // إغلاق اتصالات الـAPI حتى لا تُبقي العملية حيّة
  void api.onModuleDestroy();
}

async function main() {
  testLogger();
  testMetrics();
  testMiddleware();
  testInterceptor();
  testFilter();
  testJobMetrics();
  testQueueDepthRole();
  await testMetricsAuth();

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`نجح ${pass} — فشل ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
