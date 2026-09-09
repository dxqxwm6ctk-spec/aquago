import { spawn } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * مشغّل الاختبارات — كل ملف في عملية مستقلة.
 *
 * العزل مقصود: الاختبارات تفتح خوادم TCP ومنافذ واتصالات Redis، وتشاركها
 * في عملية واحدة يجعل تسريب اتصال في اختبار يُفشل التالي لسبب لا علاقة له
 * به. عملية لكل ملف تعني أن الفشل يشير إلى سببه.
 *
 * بلا إطار اختبار خارجي عمداً في هذه المرحلة: ما نُثبته هنا سلوك شبكي بين
 * عمليات، وjest يضيف طبقة تحويل وبيئة وهمية بلا فائدة له.
 *
 * **ملفات `docker-*.test.ts` مستبعدة من `npm test` عمداً** (المرحلة 3):
 * تتصل بحاويات Docker Compose حيّة فعلياً (db وredis وapi وapi2 وworker،
 * الأخيران بتراكب docker-compose.portability.yml) — تشغيلها ضمن `npm test`
 * العادية يُفشلها بلا سبب حقيقي في أي بيئة (محلية بلا Docker، أو CI) لا
 * تُشغّل تلك البنية أولاً. تُشغَّل يدوياً بعد `docker compose up`؛ انظر
 * توثيق كل ملف لمتطلباته الدقيقة. `npm run test:docker` يجمعها معاً.
 */
const dir = __dirname;
const isDockerTest = process.env.PHASE3_INCLUDE_DOCKER === '1';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => isDockerTest || !f.startsWith('docker-'))
  .sort();

const TSCONFIG = join(dir, 'tsconfig.json');

async function run(file: string): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}\n▶ ${file}\n${'='.repeat(60)}`);
  return new Promise((res) => {
    const p = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['ts-node', '--project', TSCONFIG, join(dir, file)],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    p.on('close', (code) => res(code === 0));
  });
}

void (async () => {
  const failed: string[] = [];
  for (const f of files) if (!(await run(f))) failed.push(f);

  console.log(`\n${'='.repeat(60)}`);
  if (failed.length) {
    console.log(`فشل ${failed.length} من ${files.length}:`);
    for (const f of failed) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`✓ نجحت ${files.length} ملفات اختبار`);
})();
