/**
 * إعداد الملفات الساكنة — حارس ضد عودة «مسار غير معروف ⇒ 500».
 *
 * يفحص الإعداد لا الشبكة: السلوك الحيّ مُغطّى في
 * `docker-runtime-integrity.test.ts` على الصورة الفعلية. هذا الملف يمسك
 * الانحدار في `npm test` العادية بلا Docker — أي عند أول `git push`
 * لا عند النشر.
 */
import { existsSync } from 'fs';
import { join } from 'path';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};

const PUBLIC_DIR = join(__dirname, '..', 'public');

function main() {
  console.log('السبب الجذري — لا index.html جذري:');
  // هذه هي الحقيقة التي تجعل المسار الجامع خطأً هنا. لو أُضيف الملف
  // يوماً (تحوّل إلى SPA) فهذا الفحص ينبّه إلى مراجعة القرار لا أكثر.
  check('public/ بلا index.html جذري (ليست SPA)',
    !existsSync(join(PUBLIC_DIR, 'index.html')));

  // كل لوحة تملك index.html خاصاً — تخدمه express.static مباشرة.
  console.log('\nكل لوحة تملك index.html خاصاً:');
  for (const dir of ['admin', 'agency', 'platform', 'app', 'apply', 'privacy', 'support', 'terms']) {
    check(`public/${dir}/index.html موجود`,
      existsSync(join(PUBLIC_DIR, dir, 'index.html')));
  }

  console.log('\nإعداد ServeStaticModule:');
  const src = require('fs').readFileSync(
    join(__dirname, '..', 'src', 'app.module.ts'), 'utf8',
  ) as string;

  // `renderPath` الافتراضي `*` يردّ index.html الجذر على كل مسار غير
  // معروف — ومع غيابه (الفحص الأول) يصير ENOENT ⇒ 500 على كل 404.
  check('renderPath مضبوط صراحةً (المسار الجامع معطَّل)',
    /renderPath\s*:/.test(src), 'غيابه يعيد سلوك الـ500');
  check('القيمة لا تطابق مساراً حقيقياً',
    /renderPath\s*:\s*['"]\/__spa_fallback_disabled__['"]/.test(src));
  // الاستثناءات تُبقي مسارات API وSocket.IO خارج الملفات الساكنة أصلاً
  check('مسارات /api و/socket.io مستثناة',
    /exclude\s*:\s*\[[^\]]*\/api\*/.test(src) && /socket\.io\*/.test(src));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`نجح ${pass} — فشل ${fail}`);
  console.log(fail === 0 ? 'النتيجة: نجاح' : 'النتيجة: فشل');
  process.exit(fail === 0 ? 0 : 1);
}

main();
