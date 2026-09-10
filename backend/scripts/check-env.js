#!/usr/bin/env node
'use strict';

/**
 * **فحص متغيّرات البيئة قبل النشر** — يُشغَّل محلياً أو داخل الحاوية.
 *
 * لماذا يستحق ملفاً: أخطاء البيئة على Railway لا تشبه أخطاء الكود. مرجعٌ
 * لخدمة باسم خاطئ (`${{اسم.VAR}}`) يُستبدل بسلسلة فارغة **بصمت**، فيبدو
 * المتغيّر معرَّفاً في اللوحة وفارغاً في الحاوية. وبعض القيم لا توقف
 * الإقلاع بل تعمل خطأً: `REDIS_URL` الغائب يقع على `localhost:6379` —
 * فتُقلع الخدمة سليمةً وتجتاز فحص الصحّة، ولا يظهر العطل إلا حين يُفتح
 * أول طلب يمرّ بطابور.
 *
 * الفحص يفصل ثلاث درجات لأن علاجها يختلف:
 *   • ❌ خطأ  — النشر سيفشل أو سيعمل خطأً. يوقف السكربت (خروج 1).
 *   • ⚠️  تحذير — يعمل، لكن بسلوكٍ غالباً غير مقصود في الإنتاج.
 *   • ℹ️  ملاحظة — اختياري غائب، تُذكر ميزته المعطَّلة ليكون الغياب قراراً.
 *
 * لا يتصل بشبكة ولا يقرأ قاعدة: يفحص ما يمكن فحصه بلا آثار جانبية، ويُشغَّل
 * قبل أن تُنشأ الخدمات أصلاً.
 *
 * الاستعمال:
 *   node scripts/check-env.js              # يقرأ البيئة الحالية
 *   node scripts/check-env.js --file .env  # يقرأ ملفاً بدل البيئة
 */

const fs = require('fs');

// ---------- قراءة المصدر ----------

function parseEnvFile(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    // القيم المقتبسة في ملفات .env — الاقتباس ليس جزءاً من القيمة.
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const fileArg = process.argv.indexOf('--file');
const env = fileArg > -1 && process.argv[fileArg + 1]
  ? parseEnvFile(process.argv[fileArg + 1])
  : process.env;

const source = fileArg > -1 ? process.argv[fileArg + 1] : 'البيئة الحالية';

// ---------- أدوات ----------

const errors = [];
const warnings = [];
const notes = [];

const val = (k) => (env[k] === undefined ? undefined : String(env[k]).trim());
const has = (k) => {
  const v = val(k);
  return v !== undefined && v !== '';
};

const isProd = val('NODE_ENV') === 'production';

/** أسرار التطوير المعروفة — مرفوضة في الإنتاج كما يرفضها `v2.module.ts`. */
const DEFAULT_SECRETS = new Set([
  'aquago-dev-secret-change-in-production',
  'aquago-dev-secret',
  'jordan-gas-dev-secret-change-in-production',
  'jordan-gas-dev-secret',
]);

// ---------- الفحوصات ----------

// 1) NODE_ENV — يحكم كل ما بعده، فغيابه ليس تفصيلاً.
if (!has('NODE_ENV')) {
  errors.push([
    'NODE_ENV',
    'غير معرَّف. بدونه تبقى حراسات الإنتاج معطَّلة: يُقبل سرّ JWT الافتراضي، ' +
      'ويُفتح CORS لأي أصل، ويعمل دخول التطوير. القيمة على Railway: production',
  ]);
} else if (!isProd) {
  warnings.push([
    'NODE_ENV',
    `القيمة "${val('NODE_ENV')}" — إن كانت هذه خدمة إنتاج فاجعلها production، ` +
      'وإلا بقيت حراسات الإنتاج كلها معطَّلة.',
  ]);
}

// 2) قاعدة البيانات — يقبل الاسمين كما يفعل docker-common.sh
if (!has('DATABASE_URL_V2') && !has('DATABASE_URL')) {
  errors.push([
    'DATABASE_URL_V2',
    'غير معرَّف (ولا DATABASE_URL يشتقّ منه). على Railway اربطه بمرجع: ' +
      '${{Postgres.DATABASE_URL}} — وتأكّد أن "Postgres" يطابق اسم خدمة القاعدة ' +
      'حرفياً، فالاسم الخاطئ يُستبدل بسلسلة فارغة بصمت.',
  ]);
} else {
  const db = val('DATABASE_URL_V2') || val('DATABASE_URL');
  if (db && !/^postgres(ql)?:\/\//.test(db)) {
    errors.push(['DATABASE_URL_V2', `لا يبدأ بـpostgresql:// — القيمة الحالية تبدأ بـ"${db.slice(0, 12)}…"`]);
  }
  if (db && /localhost|127\.0\.0\.1/.test(db) && isProd) {
    errors.push(['DATABASE_URL_V2', 'يشير إلى localhost في وضع الإنتاج — هذا رابط تطوير لا قاعدة Railway.']);
  }
}

// 3) Redis — الفخّ الصامت: الغياب يقع على localhost ولا يوقف الإقلاع.
if (!has('REDIS_URL')) {
  errors.push([
    'REDIS_URL',
    'غير معرَّف. **لا يوقف الإقلاع** — يقع على redis://localhost:6379، فتُقلع ' +
      'الخدمة وتجتاز فحص الصحّة، ثم تفشل الطوابير والمهام المجدولة بصمت. ' +
      'على Railway: ${{Redis.REDIS_URL}}',
  ]);
} else {
  const r = val('REDIS_URL');
  if (/localhost|127\.0\.0\.1/.test(r) && isProd) {
    errors.push(['REDIS_URL', 'يشير إلى localhost في وضع الإنتاج — الطوابير لن تعمل.']);
  }
  if (r.startsWith('rediss://') && ['true', '1'].includes((val('REDIS_TLS') || '').toLowerCase())) {
    notes.push(['REDIS_TLS', 'الرابط rediss:// يُفعّل TLS وحده — المتغيّر زائد هنا (غير ضارّ).']);
  }
}

// 4) JWT_SECRET — نفس منطق jwtSecret() في v2.module.ts
if (!has('JWT_SECRET')) {
  errors.push(['JWT_SECRET', 'غير معرَّف — الإقلاع يفشل في وضع الإنتاج. ولّده بـ: openssl rand -base64 48']);
} else if (DEFAULT_SECRETS.has(val('JWT_SECRET'))) {
  errors.push([
    'JWT_SECRET',
    'لا يزال بقيمة التطوير الافتراضية — سرٌّ معروف يعني توكنات قابلة للتزوير. ' +
      'ولّد غيره: openssl rand -base64 48',
  ]);
} else if (val('JWT_SECRET').length < 32) {
  warnings.push(['JWT_SECRET', `طوله ${val('JWT_SECRET').length} محرفاً — أقصر من أن يُقاوم التخمين. المقترح 48 فأكثر.`]);
}

// 5) CORS_ORIGINS — يوقف الإقلاع في الإنتاج (main.ts)
if (isProd && !has('CORS_ORIGINS')) {
  errors.push([
    'CORS_ORIGINS',
    'غير معرَّف — الإقلاع يفشل في وضع الإنتاج (لا يُفتح "*" بصمت). ' +
      'ضع نطاقات اللوحات مفصولةً بفواصل، مثل: https://admin.aquago.jo',
  ]);
} else if (has('CORS_ORIGINS')) {
  for (const o of val('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (o === '*') {
      errors.push(['CORS_ORIGINS', 'يحتوي "*" — يفتح الواجهة لأي موقع. اذكر النطاقات صراحةً.']);
    } else if (!/^https?:\/\//.test(o)) {
      warnings.push(['CORS_ORIGINS', `"${o}" بلا مخطط (https://) — لن يطابق أي أصل حقيقي.`]);
    } else if (isProd && o.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(o)) {
      warnings.push(['CORS_ORIGINS', `"${o}" على http لا https — أصلٌ غير مشفَّر في الإنتاج.`]);
    }
  }
}

// 6) التخزين — لا افتراضي صامت (storage.service.ts يرمي)
const storage = (val('STORAGE_PROVIDER') || '').toLowerCase();
if (!storage) {
  errors.push([
    'STORAGE_PROVIDER',
    'غير معرَّف — الإقلاع يفشل. القيم: local | s3. ' +
      'على Railway استعمل s3 (أو local **مع volume دائم**، وإلا ضاعت الملفات عند كل نشر).',
  ]);
} else if (storage !== 'local' && storage !== 's3') {
  errors.push(['STORAGE_PROVIDER', `القيمة "${storage}" غير معروفة — المقبول: local | s3`]);
} else if (storage === 's3') {
  const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'].filter(
    (k) => !has(k) && !has(k.replace(/^S3_/, 'STORAGE_S3_')),
  );
  if (missing.length) {
    errors.push(['STORAGE_PROVIDER=s3', `ينقصه: ${missing.join('، ')}`]);
  }
  if (!has('S3_PUBLIC_URL') && !has('STORAGE_S3_PUBLIC_URL')) {
    notes.push(['S3_PUBLIC_URL', 'غائب — الملفات تُخدَّم عبر الخادم بدل رابط عام مباشر (يعمل، لكن أبطأ).']);
  }
} else if (storage === 'local' && isProd) {
  warnings.push([
    'STORAGE_PROVIDER=local',
    'في الإنتاج: يكتب على قرص الحاوية. **بلا volume دائم مركَّب على ' +
      `${val('STORAGE_LOCAL_PATH') || '/app/storage-dev'} تضيع كل وثائق ` +
      'الانضمام والصور المرفوعة عند كل نشر.** إمّا ارفع volume أو انتقل إلى s3.',
  ]);
}

// 7) Firebase — الدخول الاجتماعي والإشعارات معاً
if (!has('FIREBASE_SERVICE_ACCOUNT_BASE64')) {
  errors.push([
    'FIREBASE_SERVICE_ACCOUNT_BASE64',
    'غير معرَّف — **دخول جوجل وآبل يفشل كلياً**، ولا إشعارات Push. ' +
      'القيمة: ملف حساب الخدمة (JSON) مُرمَّزاً base64 في سطر واحد.',
  ]);
} else {
  try {
    const j = JSON.parse(Buffer.from(val('FIREBASE_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8'));
    const pid = j.project_id || j.projectId;
    const mail = j.client_email || j.clientEmail;
    const key = j.private_key || j.privateKey;
    if (!pid || !mail) {
      errors.push(['FIREBASE_SERVICE_ACCOUNT_BASE64', 'ينقصه project_id/client_email — تأكّد أنه ملف حساب الخدمة لا google-services.json']);
    } else if (!String(key || '').includes('BEGIN PRIVATE KEY')) {
      errors.push(['FIREBASE_SERVICE_ACCOUNT_BASE64', 'المفتاح الخاص مفقود أو مشوَّه — غالباً انكسرت أسطره عند النسخ.']);
    } else {
      notes.push(['FIREBASE_SERVICE_ACCOUNT_BASE64', `سليم — مشروع ${pid}`]);
    }
  } catch {
    errors.push(['FIREBASE_SERVICE_ACCOUNT_BASE64', 'ليس JSON صالحاً بعد فكّ base64 — أعد الترميز في سطر واحد بلا أسطر جديدة.']);
  }
}

// 8) دخول التطوير — يتجاوز التحقق كلياً
if (val('AUTH_DEV_LOGIN') === '1') {
  if (isProd) {
    errors.push(['AUTH_DEV_LOGIN', '=1 في الإنتاج — يفتح دخولاً يتجاوز التحقق كلياً. احذفه.']);
  } else {
    warnings.push(['AUTH_DEV_LOGIN', '=1 — دخول بلا تحقق. مقبول في staging فقط.']);
  }
}

// 9) نقطة المقاييس
if (!has('METRICS_TOKEN')) {
  notes.push(['METRICS_TOKEN', 'غائب — نقطة /api/v2/metrics مغلقة (سلوك آمن ومقصود).']);
} else if (val('METRICS_TOKEN') === 'local-metrics-token' && isProd) {
  errors.push(['METRICS_TOKEN', 'بقيمة التطوير المعروفة في الإنتاج — ولّد غيرها أو احذف المتغيّر.']);
}

// 10) الدور والمنفذ
const role = (val('ROLE') || 'api').toLowerCase();
if (role !== 'api' && role !== 'worker') {
  errors.push(['ROLE', `القيمة "${val('ROLE')}" غير معروفة — المقبول: api | worker`]);
}
if (role === 'worker' && has('PORT')) {
  notes.push(['PORT', 'لا أثر له على العامل — لا يفتح منفذاً أصلاً.']);
}

// 11) قنوات التبليغ — اختيارية، لكن غيابها يعطّل ميزات بلا إشعار
const provider = (k, dflt) => (val(k) || dflt).toLowerCase();
if (provider('WHATSAPP_PROVIDER', 'dev') === 'dev') {
  notes.push(['WHATSAPP_PROVIDER', 'dev — لا رسائل واتساب حقيقية تُرسل.']);
} else if (!has('WHATSAPP_API_URL') || !has('WHATSAPP_API_KEY')) {
  warnings.push(['WHATSAPP_PROVIDER', `="${val('WHATSAPP_PROVIDER')}" لكن API_URL/API_KEY ناقصة — الإرسال سيفشل.`]);
}
if (provider('TELEGRAM_PROVIDER', 'dev') === 'dev') {
  notes.push(['TELEGRAM_PROVIDER', 'dev — لا تنبيهات تيليجرام للأدمن.']);
} else if (!has('TELEGRAM_BOT_TOKEN')) {
  warnings.push(['TELEGRAM_PROVIDER', `="${val('TELEGRAM_PROVIDER')}" بلا TELEGRAM_BOT_TOKEN — التنبيهات لن تصل.`]);
}
if (provider('FCM_PROVIDER', 'dev') === 'dev' && isProd) {
  warnings.push(['FCM_PROVIDER', 'dev في الإنتاج — لا إشعارات Push فعلية. اجعله firebase.']);
}

// ---------- التقرير ----------

const line = (icon, pairs) => pairs.forEach(([k, m]) => console.log(`  ${icon} ${k}\n      ${m}\n`));

console.log(`\n🔍 فحص متغيّرات البيئة — المصدر: ${source}`);
console.log(`   الوضع: ${val('NODE_ENV') || '(غير معرَّف)'} · الدور: ${role}\n`);

if (errors.length) {
  console.log(`❌ أخطاء توقف النشر (${errors.length}):\n`);
  line('❌', errors);
}
if (warnings.length) {
  console.log(`⚠️  تحذيرات — يعمل بسلوك قد لا يكون مقصوداً (${warnings.length}):\n`);
  line('⚠️ ', warnings);
}
if (notes.length) {
  console.log(`ℹ️  ملاحظات — اختياري غائب (${notes.length}):\n`);
  line('ℹ️ ', notes);
}

if (!errors.length && !warnings.length) {
  console.log('✅ لا أخطاء ولا تحذيرات.\n');
} else if (!errors.length) {
  console.log('✅ لا أخطاء توقف النشر.\n');
}

process.exit(errors.length ? 1 : 0);
