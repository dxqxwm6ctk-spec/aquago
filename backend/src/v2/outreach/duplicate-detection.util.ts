import type { AgencyLead } from '@prisma-v2/client';
import type { PrismaV2Service } from '../database/prisma-v2.service';
import { toJordanE164 } from '../common/phone.util';

/**
 * نتيجة البحث عن تكرار.
 *
 * التمييز بين `certain` و`possible` هو كل الفكرة: الأول يُحدَّث فوقه (بحذر،
 * انظر `mergeableFields`)، والثاني **لا يُدمج تلقائياً أبداً** — يُنشأ السجل
 * ويُوسم بأنه ربما يكرّر غيره، ويقرر الأدمن. دمجٌ خاطئ يخلط وكالتين
 * حقيقيتين بلا رجعة؛ صفّان متجاوران يُصلحان بضغطة.
 */
export type DuplicateMatch =
  | { kind: 'none' }
  | { kind: 'certain'; lead: AgencyLead; matchedOn: DuplicateKey }
  | { kind: 'possible'; lead: AgencyLead; matchedOn: DuplicateKey };

export type DuplicateKey =
  | 'phoneNumber'
  | 'whatsappNumber'
  | 'licenseNumber'
  | 'externalId'
  | 'nameAndArea'
  | 'nameAndAddress'
  | 'proximity';

export interface DuplicateCandidate {
  name?: string | null;
  phoneNumber?: string | null;
  whatsappNumber?: string | null;
  licenseNumber?: string | null;
  externalId?: string | null;
  areaId?: string | null;
  areaName?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** تطبيع للمقارنة وحدها — لا يُخزَّن، ولا يغيّر ما ورد من المصدر */
export const normalizeName = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    // ألف بأشكالها، وتاء مربوطة/هاء، وياء/ألف مقصورة — اختلافات إملائية لا معنوية
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ً-ْ]/g, '')
    .replace(/\s+/g, ' ')
    // ألقاب تجارية شائعة لا تميّز وكالة عن أخرى
    .replace(/^(شركة|مؤسسة|وكالة|محل|مركز)\s+/, '');

/** رقم للمقارنة: الأردني إلى E.164، وغيره إلى أرقامه المجرّدة */
export const normalizePhoneForMatch = (raw: string): string =>
  toJordanE164(raw) ?? raw.replace(/\D/g, '');

/**
 * البحث بالترتيب المطلوب. أول مطابقة تفوز — الأقوى أولاً، فلا يُصنَّف تطابق
 * رقم هاتف كـ«محتمل» لمجرد أن الاسم مختلف.
 */
export async function findDuplicate(
  prisma: PrismaV2Service,
  c: DuplicateCandidate,
): Promise<DuplicateMatch> {
  const phone = c.phoneNumber ? normalizePhoneForMatch(c.phoneNumber) : null;
  const wa = c.whatsappNumber ? normalizePhoneForMatch(c.whatsappNumber) : null;

  // 1) رقم الهاتف — أقوى دليل: وكالتان لا تتقاسمان رقماً
  if (phone) {
    const hit = await prisma.agencyLead.findFirst({
      where: { OR: [{ phoneNumber: phone }, { whatsappNumber: phone }] },
    });
    if (hit) return { kind: 'certain', lead: hit, matchedOn: 'phoneNumber' };
  }

  // 2) رقم الواتساب
  if (wa && wa !== phone) {
    const hit = await prisma.agencyLead.findFirst({
      where: { OR: [{ whatsappNumber: wa }, { phoneNumber: wa }] },
    });
    if (hit) return { kind: 'certain', lead: hit, matchedOn: 'whatsappNumber' };
  }

  // 3) رقم الترخيص — معرّف رسمي فريد بطبيعته
  if (c.licenseNumber?.trim()) {
    const hit = await prisma.agencyLead.findFirst({
      where: { licenseNumber: c.licenseNumber.trim() },
    });
    if (hit) return { kind: 'certain', lead: hit, matchedOn: 'licenseNumber' };
  }

  // 4) معرّف السجل لدى المصدر الخارجي (place_id ونحوه)
  if (c.externalId?.trim()) {
    const src = await prisma.agencyDataSource.findFirst({
      where: { externalId: c.externalId.trim() },
      include: { lead: true },
    });
    if (src) return { kind: 'certain', lead: src.lead, matchedOn: 'externalId' };
  }

  // ما دون هذا ظنّي: الأسماء تتشابه، و«الوكالة الوطنية» في منطقتين مختلفتين
  // قد تكون فرعين لشركة واحدة أو محلّين لا صلة بينهما.
  const normalized = c.name ? normalizeName(c.name) : null;
  if (!normalized) return { kind: 'none' };

  // 5) اسم + منطقة
  if (c.areaId || c.areaName?.trim()) {
    const sameArea = await prisma.agencyLead.findMany({
      where: c.areaId
        ? { areaId: c.areaId }
        : { areaName: { equals: c.areaName!.trim(), mode: 'insensitive' } },
      take: 200,
    });
    const hit = sameArea.find((l) => normalizeName(l.name) === normalized);
    if (hit) return { kind: 'possible', lead: hit, matchedOn: 'nameAndArea' };
  }

  // 6) اسم + عنوان
  if (c.address?.trim()) {
    const sameAddress = await prisma.agencyLead.findMany({
      where: { address: { equals: c.address.trim(), mode: 'insensitive' } },
      take: 200,
    });
    const hit = sameAddress.find((l) => normalizeName(l.name) === normalized);
    if (hit) return { kind: 'possible', lead: hit, matchedOn: 'nameAndAddress' };
  }

  // 7) قرب جغرافي + تشابه اسم — آخر المفاتيح وأضعفها
  if (c.latitude != null && c.longitude != null) {
    // نافذة خشنة على درجات الإحداثيات ثم مسافة دقيقة داخلها: الفلترة في
    // القاعدة تمنع سحب كل السجلات إلى الذاكرة، والحساب هنا يحسم.
    const d = NEAR_DUPLICATE_METERS / 111_320; // درجة عرض ≈ 111.3 كم
    const near = await prisma.agencyLead.findMany({
      where: {
        latitude: { gte: c.latitude - d, lte: c.latitude + d },
        longitude: { gte: c.longitude - d * 1.3, lte: c.longitude + d * 1.3 },
      },
      take: 200,
    });
    const hit = near.find(
      (l) =>
        l.latitude != null &&
        l.longitude != null &&
        normalizeName(l.name) === normalized &&
        metersBetween(c.latitude!, c.longitude!, l.latitude, l.longitude) <=
          NEAR_DUPLICATE_METERS,
    );
    // «محتمل» لا «مؤكد» حتى مع تطابق الاسم: سوقٌ واحد قد يضمّ فرعين لصاحب
    // واحد على بعد أمتار، ودمجهما يمحو فرعاً حقيقياً.
    if (hit) return { kind: 'possible', lead: hit, matchedOn: 'proximity' };
  }

  return { kind: 'none' };
}

/**
 * نصف قطر اعتبار السجلين «في المكان نفسه». مئة متر: إحداثيات الأدلة العامة
 * تشير إلى وسط الشارع أو مبنى مجاور كثيراً، فأقلّ من ذلك يفوّت تكراراً
 * حقيقياً، وأكثر منه يجمع محلّين متجاورين لا صلة بينهما.
 */
const NEAR_DUPLICATE_METERS = 100;

/** مسافة هافرساين بالأمتار */
function metersBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * ما يجوز تعبئته على سجل قائم من مصدر جديد: **الفراغات وحدها.**
 *
 * المصدر الثاني يكمل ما ينقص ولا يصحّح ما هو موجود — ملف استيراد قديم لا
 * يجوز أن يمحو رقماً أكّده موظف بالهاتف. تعديل قيمة قائمة يبقى فعلاً بشرياً
 * عبر PATCH لا أثراً جانبياً لاستيراد.
 */
export function fillOnlyBlanks<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
): Partial<T> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === '') continue;
    const current = existing[key as keyof T];
    if (current === null || current === undefined || current === '') {
      patch[key] = value;
    }
  }
  return patch as Partial<T>;
}
