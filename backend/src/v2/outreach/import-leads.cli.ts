/**
 * استيراد الوكالات المحتملة المجموعة من مصادر عامة إلى AgencyLead.
 *
 * **لا يبني شيئاً جديداً**: يمرّ على `LeadImportService` نفسها التي يستعملها
 * مسار `POST /api/v2/agency-leads/import` — نفس كشف التكرار، ونفس التطبيع،
 * ونفس `PENDING_REVIEW`، ونفس صفّ `AgencyLeadImport`. الفرق أنه يعمل بلا
 * خادم ولا توكن، عبر سياق تطبيق Nest.
 *
 * تشغيل:
 *   npm run leads:import -- --dry-run  tools/agency-leads/dataset/*.jsonl
 *   npm run leads:import -- --actor <userId>  tools/agency-leads/dataset/*.jsonl
 *
 * `--dry-run` هو الافتراضي المتعمَّد: الاستيراد يكتب في قاعدة حيّة، فلا يجوز
 * أن يقع بالخطأ من سطر أمرٍ ناقص. الكتابة تحتاج `--commit` صراحةً.
 *
 * لا يرسل هذا السكربت رسالة واتساب واحدة ولا ينشئ حملة ولا يدرج مهمة في أي
 * طابور — الاستيراد ينتهي عند PENDING_REVIEW، وما بعده قرار بشري.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import { PrismaV2Module } from '../database/prisma-v2.module';
import { FirebaseAdminModule } from '../firebase/firebase-admin.module';
import { FcmService } from '../notifications/fcm.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramService } from '../notifications/telegram.service';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { RedisV2Module } from '../redis/redis.module';
import { AgencyLeadsService } from './agency-leads.service';
import { LeadImportService } from './lead-import.service';
import { AREA_ALIASES, areaKeyCandidates, normalizeAreaKey } from './area-aliases';

/**
 * وحدة صغيرة تحمل ما يلزم الاستيراد وحده.
 *
 * **لا `AppModule` هنا عمداً.** فتحُ التطبيق كاملاً يشغّل عامل التوزيع وعامل
 * واتساب وبوابة الـsocket لثوانٍ ثم يُغلقها — وهذا السكربت يعمل داخل
 * `docker-entrypoint.sh` قبل الخادم الحقيقي، فعمّالٌ يقلعون ويموتون هناك
 * إزعاجٌ في أحسن الأحوال ومهامٌ تُلتقط وتُترك في أسوئها. الخدمة المستوردة
 * نفسها بلا تغيير — التغيير في ما نوقظه حولها.
 */
@Module({
  // AgencyLeadsService صارت تنبّه الفريق بطلبات التسجيل، فتحتاج خدمتَي
  // الإشعارات. نحقنهما مباشرةً لا عبر NotificationsV2Module: تلك تحمل
  // controllers، وحقن حرّاسها في سياق بلا HTTP مخاطرةٌ لا داعي لها هنا.
  // و`@Global` لا يغني عن ذلك — الوحدة العامة لا تصير عامة إلا بعد أن
  // تُستورد مرة في الرسم، وهذا رسمٌ مستقلّ عن AppModule.
  imports: [PrismaV2Module, RedisV2Module, FirebaseAdminModule],
  providers: [
    AgencyLeadsService,
    LeadImportService,
    NotificationsService,
    TelegramService,
    FcmService,
  ],
})
class LeadImportCliModule {}

interface RawRecord {
  name: string;
  businessName?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  alternativePhoneNumber?: string | null;
  areaName?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  licenseStatus?: string | null;
  licenseNumber?: string | null;
  licenseSource?: string | null;
  dataSource?: string | null;
  sourceUrl?: string | null;
  externalId?: string | null;
  notes?: string | null;
  collectedAt?: string | null;
}

function readJsonl(paths: string[]): { record: RawRecord; file: string }[] {
  const out: { record: RawRecord; file: string }[] = [];
  for (const p of paths) {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      try {
        out.push({ record: JSON.parse(t) as RawRecord, file: `${p}:${i + 1}` });
      } catch {
        console.error(`⚠️  سطر غير صالح، تُخطّي: ${p}:${i + 1}`);
      }
    }
  }
  return out;
}

/**
 * يربط السجلات التي تحمل اسم منطقة نصّياً بمنطقة مسجَّلة، إن وُجدت الآن.
 *
 * تعمل على كل السجلات لا على دفعة بعينها، وتلمس `areaId` وحده — لا تعدّل
 * `areaName` ولا أي حقل آخر، فاسم المصدر يبقى كما ورد حتى بعد الربط.
 */
async function relinkAreas(prisma: PrismaV2Service) {
  const districts = await prisma.district.findMany({ select: { id: true, nameAr: true } });
  const byKey = new Map(districts.map((d) => [normalizeAreaKey(d.nameAr), d.id]));

  const orphans = await prisma.agencyLead.findMany({
    where: { areaId: null, areaName: { not: null } },
    select: { id: true, areaName: true },
  });
  let linked = 0;
  for (const lead of orphans) {
    // كل صيغة محتملة للاسم، ثم مرادفات كلٍّ منها
    const keys = areaKeyCandidates(lead.areaName!);
    const withAliases = keys.flatMap((k) => [
      k,
      ...(AREA_ALIASES[k] ?? []).map((a) => normalizeAreaKey(a)),
    ]);
    for (const k of withAliases) {
      const hit = byKey.get(k);
      if (hit) {
        await prisma.agencyLead.update({ where: { id: lead.id }, data: { areaId: hit } });
        linked++;
        break;
      }
    }
  }
  console.log(
    `🗺️  ${districts.length} منطقة مسجَّلة · رُبط ${linked} من ${orphans.length} سجلاً بلا منطقة`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const actorFlag = argv.indexOf('--actor');
  const actorArg = actorFlag >= 0 ? argv[actorFlag + 1] : undefined;
  const files = argv.filter((a) => a.endsWith('.jsonl'));
  if (!files.length) {
    console.error('❌ لا ملفات .jsonl في المعاملات');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(LeadImportCliModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaV2Service);
  const imports = app.get(LeadImportService);

  // يُنادى من docker-entrypoint.sh عند كل إقلاع. كشف التكرار يجعل الإعادة
  // غير ضارّة، لكنها ٦٧ صفاً × عدة استعلامات في كل مرة بلا فائدة — والراية
  // تجعلها مرة واحدة فعلاً.
  if (argv.includes('--skip-if-any')) {
    const already = await prisma.agencyLead.count();
    if (already > 0) {
      console.log(`⏭️  ${already} سجلاً موجود مسبقاً — تخطّي الاستيراد`);
      // لكن نعيد ربط المناطق قبل الخروج: أول دفعة نزلت وفي القاعدة خمس
      // مناطق فقط، فبقيت أكثر السجلات بـareaId فارغ. إضافة المناطق لاحقاً
      // لا تربط شيئاً بنفسها — هذا ما يربطها.
      await relinkAreas(prisma);
      await app.close();
      return;
    }
  }

  // ---- خريطة المناطق: نربط بما هو مسجَّل، ولا نخترع منطقة ----
  const districts = await prisma.district.findMany({
    select: { id: true, nameAr: true, city: { select: { nameAr: true } } },
  });
  const districtByKey = new Map(districts.map((d) => [normalizeAreaKey(d.nameAr), d.id]));
  console.log(`🗺️  ${districts.length} منطقة مسجَّلة في القاعدة`);

  const rows = readJsonl(files);
  console.log(`📥 ${rows.length} سجلاً من ${files.length} ملف`);

  let mappedArea = 0;
  let unmappedArea = 0;
  const unmapped = new Map<string, number>();

  const mapped = rows.map(({ record }) => {
    let areaId: string | undefined;
    const raw = record.areaName?.trim();
    if (raw) {
      // الاسم كما ورد، ثم مرادفاته المعروفة — أول ما يطابق منطقة مسجَّلة يفوز
      const candidates = [raw, ...(AREA_ALIASES[normalizeAreaKey(raw)] ?? [])];
      for (const c of candidates) {
        const hit = districtByKey.get(normalizeAreaKey(c));
        if (hit) {
          areaId = hit;
          break;
        }
      }
      if (areaId) mappedArea++;
      else {
        unmappedArea++;
        unmapped.set(raw, (unmapped.get(raw) ?? 0) + 1);
      }
    } else {
      unmappedArea++;
    }

    // أسماء الأعمدة هي التي يفهمها COLUMN_ALIASES في المستورد القائم —
    // لا مسار جانبي ولا نسخة ثانية من منطق التحويل
    return {
      name: record.name,
      businessname: record.businessName ?? '',
      phone: record.phoneNumber ?? '',
      whatsapp: record.whatsappNumber ?? '',
      altphone: record.alternativePhoneNumber ?? '',
      area: record.areaName ?? '',
      neighborhood: record.neighborhood ?? '',
      address: record.address ?? '',
      lat: record.latitude ?? '',
      lng: record.longitude ?? '',
      licensestatus: record.licenseStatus ?? 'UNKNOWN',
      licensenumber: record.licenseNumber ?? '',
      licensesource: record.licenseSource ?? '',
      datasource: record.dataSource ?? 'OTHER',
      sourceurl: record.sourceUrl ?? '',
      externalid: record.externalId ?? '',
      notes: record.notes ?? '',
      __areaId: areaId ?? '',
    } as Record<string, unknown>;
  });

  console.log(`🗺️  رُبطت ${mappedArea} منطقة، تعذّر ربط ${unmappedArea}`);
  if (unmapped.size) {
    console.log('   مناطق بلا مقابل مسجَّل (تُحفظ نصّاً في areaName):');
    for (const [name, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${name}  ×${n}`);
    }
  }

  if (!commit) {
    console.log('\n🧪 تشغيل تجريبي (--dry-run افتراضي). لا شيء كُتب في القاعدة.');
    console.log('   للكتابة فعلاً: أضف --commit و--actor <userId>');
    await app.close();
    return;
  }

  // الفاعل مستخدم حقيقي: كل صفٍّ يُنشأ يكتب سطراً في سجل التدقيق باسمه،
  // ومعرّف مخترع يجعل السجل بلا معنى ويكسر مفتاح AgencyLeadImport.startedById
  const actorId =
    actorArg ??
    (
      await prisma.userRole.findFirst({
        where: { role: { name: 'SUPER_ADMIN' } },
        select: { userId: true },
      })
    )?.userId;
  if (!actorId) {
    console.error('❌ لا فاعل: مرّر --actor <userId> أو تأكد من وجود SUPER_ADMIN');
    await app.close();
    process.exit(1);
  }
  const actor = await prisma.user.findUnique({ where: { id: actorId } });
  if (!actor) {
    console.error(`❌ المستخدم ${actorId} غير موجود`);
    await app.close();
    process.exit(1);
  }
  console.log(`\n✍️  الاستيراد باسم: ${actor.name} (${actorId})`);

  const batch = await imports.start(mapped, files.join(', '), actorId);
  console.log(`⏳ دفعة ${batch.id} — بانتظار انتهاء المعالجة…`);

  // المعالجة في المستورد تجري خلف الطلب (بلا await) — ننتظر انتهاءها هنا
  // لأن السكربت يجب ألا يخرج قبل أن تكتمل ولا أن يترك القاعدة نصف مكتوبة
  // 90 ثانية سقفاً: النافذة كلها عند Railway خمس دقائق، والانتظار
  // الأطول من ذلك يُسقط النشر بدل أن يؤخّره
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const row = await prisma.agencyLeadImport.findUnique({ where: { id: batch.id } });
    if (row && ['COMPLETED', 'PARTIAL', 'FAILED'].includes(row.status)) {
      console.log(
        `\n✅ ${row.status}: أُنشئ ${row.created}، حُدّث ${row.updated}، ` +
          `مكرر ${row.duplicates}، متخطّى ${row.skipped}، أخطاء ${row.errors}`,
      );
      break;
    }
  }

  // ربط المناطق بعد الإنشاء: المستورد يحفظ `areaName` نصّاً ولا يعرف مناطقنا.
  // نفس الدالة التي يستعملها مسار التخطّي — منطق ربط واحد لا اثنان يتفرّقان.
  await relinkAreas(prisma);

  await app.close();
}

/**
 * الخروج صريح عمداً.
 *
 * `app.close()` لا ينهي العملية: عميل Redis المشترك يُنشأ بـ`lazyConnect:
 * false` وبلا `onModuleDestroy`، فيبقى ماسكاً حلقة الأحداث بعد إغلاق السياق.
 * هذا مقبول في خادم يعمل بلا نهاية، وقاتل في سكربت يعمل داخل
 * `docker-entrypoint.sh` قبل الخادم: العملية لا تنتهي، فلا يُنفَّذ السطر
 * التالي، فلا يقلع الخادم أصلاً ويسقط فحص الصحة على 502.
 */
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
