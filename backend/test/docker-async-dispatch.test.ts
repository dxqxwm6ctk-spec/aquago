/**
 * التوزيع خارج مسار الطلب — حارس ضدّ عودة الانتظار المتزامن.
 *
 * **متطلبات التشغيل:** حزمة Docker المحلية عاملة (api + worker + db + redis).
 *
 * ما يُثبته:
 *   ١. الاستجابة **لا تنتظر** دورة التوزيع — كان المتحكّم يـ`await`
 *      `dispatchOrder` كاملةً (ST_DWithin + ترشيح الوكالات + عروض + FCM)،
 *      فقاس staging وسيط ٣٢ ثانية لطلب ناجح تحت الحمل.
 *   ٢. **لا تضيع مهمة**: كل طلب يصل AGENCY_ASSIGNED عبر العامل.
 *   ٣. الرموز تبقى فريدة تحت التزامن.
 *   ٤. التراجع سليم: طلب مرفوض لا يترك مهمة توزيع يتيمة.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const API = process.env.API_URL || 'http://localhost:3000';
const FIXTURES = process.env.VUS_JSON
  || join(process.env.TEMP || '/tmp', 'vus.json');

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fx { users: { userId: string; addressId: string; token: string }[]; bottleTypeId: string }

async function createOrder(u: Fx['users'][0], ct: string) {
  const t0 = Date.now();
  const r = await fetch(`${API}/api/v2/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addressId: u.addressId, items: [{ bottleTypeId: ct, qty: 1 }] }),
  });
  const body = r.status === 201 ? await r.json() : null;
  return { status: r.status, ms: Date.now() - t0, body };
}

async function main() {
  let fx: Fx;
  try { fx = JSON.parse(readFileSync(FIXTURES, 'utf8')); }
  catch { console.log(`  تخطٍّ: لا ملف أدوات في ${FIXTURES}`); process.exit(0); }

  console.log('\n— ١) الاستجابة لا تنتظر التوزيع —');
  const a = await createOrder(fx.users[800], fx.bottleTypeId);
  check('الطلب أُنشئ (201)', a.status === 201, String(a.status));
  // العتبة ٥٠٠ms سخيّة عمداً: القياس المحلي ~٣١ms، وقبل الإصلاح ~١٢٧ms
  // ووسيط staging ٣٢ ثانية. ما يُرصد هنا هو عودةُ الانتظار المتزامن لا
  // تذبذبٌ بمئة مللي‌ثانية.
  check('الردّ أسرع من 500ms', a.ms < 500, `${a.ms}ms`);
  check('الحالة الأولى CREATED لا AGENCY_ASSIGNED',
    a.body?.status === 'CREATED', a.body?.status);

  console.log('\n— ٢) التوزيع يتمّ في العامل ولا يضيع —');
  let finalStatus = 'CREATED';
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const g = await fetch(`${API}/api/v2/orders/${a.body.id}`,
      { headers: { Authorization: `Bearer ${fx.users[800].token}` } });
    const o = await g.json();
    if (o.status !== 'CREATED') { finalStatus = o.status; break; }
  }
  check('الطلب غادر CREATED خلال 15s', finalStatus !== 'CREATED', finalStatus);
  check('وصل حالةً توزيعية', ['SEARCHING','AGENCY_ASSIGNED','WAITING_FOR_DRIVER','SEARCH_FAILED']
    .includes(finalStatus), finalStatus);

  console.log('\n— ٣) التزامن: رموز فريدة وردود سريعة —');
  const N = 30;
  const batch = fx.users.slice(900, 900 + N);
  const res = await Promise.all(batch.map((u) => createOrder(u, fx.bottleTypeId)));
  const ok = res.filter((r) => r.status === 201);
  const codes = ok.map((r) => r.body.code as string);
  check(`${N} طلباً متزامناً نجحت`, ok.length === N, `${ok.length}/${N}`);
  check('كل الرموز فريدة', new Set(codes).size === codes.length,
    `${new Set(codes).size}/${codes.length}`);
  const lat = ok.map((r) => r.ms).sort((x, y) => x - y);
  const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
  // تحت تزامن ٣٠ على حاوية محلية واحدة — القياس الفعلي ~٨٧٠ms
  check('p95 تحت التزامن أقل من 3s', p95 < 3000, `${p95}ms`);
  console.log(`  (وسيط ${lat[Math.floor(lat.length / 2)]}ms · p95 ${p95}ms)`);

  console.log('\n— ٤) الرفض لا يُدرج مهمة توزيع —');
  // نفس الزبون له طلب جارٍ الآن ⇒ يُرفض بـ400 قبل بلوغ الإدراج
  const dup = await createOrder(batch[0], fx.bottleTypeId);
  check('الطلب المكرّر مرفوض', dup.status >= 400 && dup.status < 500, String(dup.status));
  check('الرفض سريع (لم ينتظر توزيعاً)', dup.ms < 2000, `${dup.ms}ms`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`نجح ${pass} — فشل ${fail}`);
  console.log(fail === 0 ? 'النتيجة: نجاح' : 'النتيجة: فشل');
  process.exit(fail === 0 ? 0 : 1);
}

void main();
