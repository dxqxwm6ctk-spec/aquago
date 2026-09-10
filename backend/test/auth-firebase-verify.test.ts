import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FirebaseNotConfiguredError } from '../src/v2/firebase/firebase-admin.service';
import { AuthV2Service } from '../src/v2/auth/auth-v2.service';

/**
 * **فصل عطل التهيئة عن التوكن غير الصالح** في `verifyFirebaseToken`.
 *
 * ما يُثبته: خادمٌ بلا حساب خدمة يردّ 503، وتوكنٌ مزوَّر يردّ 401 — وكلاهما
 * كان يردّ 401 قبل هذا التغيير. هذا الالتباس بعينه كلّف تشخيصاً طويلاً:
 * ظهر عطل الإعداد على أنه توكن غير صالح، فبُحث عنه في التطبيق ولدى المزوّد
 * بينما موضعه متغيّرُ بيئةٍ فارغ.
 *
 * ويُثبت معه أن نصّ خطأ التهيئة لا يُسرَّب في الرد: نصّه يصف بنية إعدادنا.
 *
 * الحكم الصحيح على هذا الاختبار: **منطقيٌّ خالص على الدالة الحقيقية.**
 * `verifyIdToken` وحده محاكى — وهو حدّ الشبكة الذي لا يُختبر هنا؛ الدالة
 * المُختبَرة والأنواع وشجرة القرار كلها حقيقية. لا قاعدة ولا Redis: الدالة
 * لا تلمس أياً منهما، فحقنها كائناً فارغاً يكشف أي اعتماد يُضاف لاحقاً.
 */

let pass = 0;
let fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

/**
 * الخدمة الحقيقية بتبعيات فارغة: `verifyFirebaseToken` لا ينادي غير
 * `firebaseAdmin.auth()`، فما عداه لا يُبنى. لو استُدعي شيء آخر لاحقاً
 * فسيفشل الاختبار صراحةً بدل أن يمرّ على محاكاة متساهلة.
 */
function serviceWith(authImpl: () => never | Promise<unknown>): AuthV2Service {
  const firebaseAdmin = {
    auth: () => ({ verifyIdToken: async () => authImpl() }),
  };
  return new AuthV2Service(
    undefined as never, // prisma
    undefined as never, // jwt
    firebaseAdmin as never,
    undefined as never, // whatsapp
    undefined as never, // otpDelivery
    undefined as never, // gateway
    undefined as never, // reviewAccount
    undefined as never, // redis
  );
}

/** الدالة خاصة — تُنادى عبر فهرسة، فالاختبار لا يفرض توسيع سطحها العام. */
const verify = (svc: AuthV2Service, token: string) =>
  (svc as unknown as {
    verifyFirebaseToken: (t: string, c: string, m: string) => Promise<unknown>;
  }).verifyFirebaseToken(token, 'google-login', 'رسالة التوكن غير الصالح');

async function main() {
  // ---- 1) تهيئة مفقودة → 503 لا 401 ----
  console.log('حساب خدمة Firebase غائب:');
  const configMsg =
    'FIREBASE_SERVICE_ACCOUNT_BASE64 غير معرَّف — لا Firebase Admin ولا إشعارات Push';
  const notConfigured = serviceWith(() => {
    throw new FirebaseNotConfiguredError(configMsg);
  });

  let thrown: unknown;
  try {
    await verify(notConfigured, 'any-token');
  } catch (e) {
    thrown = e;
  }

  check(
    'يرمي ServiceUnavailableException (503)',
    thrown instanceof ServiceUnavailableException,
    `رُمي بدله: ${(thrown as Error)?.constructor?.name}`,
  );
  check(
    'لا يرمي UnauthorizedException — هذا هو الالتباس القديم بعينه',
    !(thrown instanceof UnauthorizedException),
  );

  // 401 يجعل التطبيق يمسح توكناته وينهي الجلسة، فعطلٌ عابر في الخادم كان
  // يُخرج كل من يفتح التطبيق أثناءه. 503 لا يفعل.
  const status = (thrown as { getStatus?: () => number })?.getStatus?.();
  check('الحالة 503', status === 503, `الحالة: ${status}`);

  const body = (thrown as { getResponse?: () => unknown })?.getResponse?.();
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  check(
    'الرسالة عامة — لا تسريب لاسم متغيّر البيئة في الرد',
    !text.includes('FIREBASE_SERVICE_ACCOUNT_BASE64'),
    text,
  );

  // ---- 2) توكن غير صالح → 401 كما كان ----
  console.log('\nتوكن مزوَّر أو منتهٍ:');
  const badToken = serviceWith(() => {
    throw new Error('Decoding Firebase ID token failed');
  });

  thrown = undefined;
  try {
    await verify(badToken, 'fake.token.here');
  } catch (e) {
    thrown = e;
  }

  check(
    'يرمي UnauthorizedException (401)',
    thrown instanceof UnauthorizedException,
    `رُمي بدله: ${(thrown as Error)?.constructor?.name}`,
  );
  check(
    'الحالة 401',
    (thrown as { getStatus?: () => number })?.getStatus?.() === 401,
  );

  // ---- 3) التوكن السليم يمرّ كما هو ----
  console.log('\nتوكن سليم:');
  const good = serviceWith(async () => ({ uid: 'uid-123', email: 'a@b.com' }));
  const decoded = (await verify(good, 'good-token')) as { uid: string };
  check('يُعيد الحمولة المفكوكة بلا تعديل', decoded?.uid === 'uid-123');

  console.log(`\nنجح ${pass}، فشل ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
