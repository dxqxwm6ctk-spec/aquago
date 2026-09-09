import { OnboardingFieldMode } from '@prisma-v2/client';

/**
 * كتالوج ملف المنشأة — **مصدر الحقيقة الوحيد** لما يمكن أن يُطلب من وكالة.
 *
 * القسمة بين الشيفرة والقاعدة مقصودة:
 *  - الشيفرة تعرّف **ماهية** الحقل: مفتاحه، عموده في القاعدة، نوعه، تحققه،
 *    وشرط ظهوره. هذه أمور لا يجوز أن يخترعها أحد من لوحة تحكّم — عمودٌ لا
 *    وجود له أو تحققٌ لا ينفَّذ يعني بياناتٍ فاسدة بصمت.
 *  - القاعدة (`AgencyOnboardingRequirement`) تحمل **حالة** الحقل وحدها:
 *    مخفي أو اختياري أو إلزامي، وتسميةً بديلة إن شاء الأدمن.
 *
 * فما يُطلب من الوكالات يتغيّر بضغطة من اللوحة، وما يُخزَّن ويُتحقَّق منه
 * لا يتغيّر إلا بنشر إصدار. مفتاحٌ يُحذف من هنا يصير صفُّه في القاعدة
 * مهمَلاً بلا أثر — والعكس (صفٌّ لمفتاح مجهول) يُتجاهَل.
 */

export type FieldKind =
  | 'text'
  | 'longText'
  | 'date'
  | 'email'
  | 'phone'
  | 'nationalId'
  | 'iban'
  | 'select'
  | 'bool';

/** أعمدة `AgencyOnboarding` التي يكتب فيها النموذج — قائمة مغلقة */
export type OnboardingColumn =
  | 'entityType'
  | 'legalNameAr'
  | 'commercialRegistryNo'
  | 'nationalEstablishmentNo'
  | 'registeredAt'
  | 'registryPlace'
  | 'officialEmail'
  | 'addrGovernorate'
  | 'addrDistrict'
  | 'addrNeighborhood'
  | 'addrStreet'
  | 'addrBuildingNo'
  | 'addrPostalCode'
  | 'ownerSigns'
  | 'proxyNumber'
  | 'proxyDate'
  | 'signerName'
  | 'signerNationality'
  | 'signerNationalId'
  | 'signerBirthDate'
  | 'signerPhone'
  | 'signerRole'
  | 'taxNumber'
  | 'vatRegistered'
  | 'vatNumber'
  | 'bankNameAr'
  | 'bankBranch'
  | 'accountHolderName'
  | 'iban'
  | 'walletAlias';

/** ما تحتاجه شروط الظهور من الملف — لا الصفّ كاملاً */
export interface FormShape {
  entityType?: string | null;
  ownerSigns?: boolean | null;
  vatRegistered?: boolean | null;
}

export interface CatalogField {
  key: string;
  step: number;
  labelAr: string;
  hintAr?: string;
  kind: FieldKind;
  column: OnboardingColumn;
  defaultMode: OnboardingFieldMode;
  maxLength?: number;
  options?: { value: string; labelAr: string }[];
  /** يظهر فقط حين يتحقق الشرط — وما لا يظهر لا يُطلب مهما كانت حالته */
  showIf?: (f: FormShape) => boolean;
  /**
   * غير قابل لتغيير الحالة من اللوحة. محجوزٌ لمفاتيح التفرّع وحدها:
   * الصفة القانونية ومن يوقّع ليسا بيانات تُجمع بل سؤالان يحدّدان بقية
   * النموذج. إخفاء أحدهما يترك الخادم بلا جواب عمّا يُظهر أصلاً.
   */
  locked?: boolean;
}

export interface CatalogLicense {
  key: string;
  labelAr: string;
  authorityAr: string;
  defaultMode: OnboardingFieldMode;
  /** رخصة سنوية تنتهي — يُطلب تاريخ انتهائها ويُنبَّه قبله */
  expires: boolean;
}

export interface CatalogDocument {
  key: string;
  labelAr: string;
  hintAr?: string;
  defaultMode: OnboardingFieldMode;
  showIf?: (f: FormShape) => boolean;
}

const isLlc = (f: FormShape) => f.entityType === 'LLC';
const needsProxy = (f: FormShape) => f.ownerSigns === false;
const isVat = (f: FormShape) => f.vatRegistered === true;

const R = OnboardingFieldMode.REQUIRED;
const O = OnboardingFieldMode.OPTIONAL;

export const STEPS: { step: number; titleAr: string; hintAr: string; descAr: string }[] = [
  {
    step: 1,
    titleAr: 'هوية المنشأة',
    hintAr: 'السجل، الصفة، العنوان',
    descAr: 'ابدأ بالصفة القانونية — هذا الاختيار يحكم باقي النموذج ومن يحق له التوقيع.',
  },
  {
    step: 2,
    titleAr: 'المفوّض بالتوقيع',
    hintAr: 'الشخص الذي يلتزم بالعقد',
    descAr: 'العقد يربط شخصاً بعينه لا اسماً تجارياً؛ حدد الموقّع بدقة.',
  },
  {
    step: 3,
    titleAr: 'الوضع الضريبي',
    hintAr: 'الرقم الضريبي والمبيعات',
    descAr: 'رقمان مختلفان من نفس الدائرة — لا تخلط بينهما.',
  },
  {
    step: 4,
    titleAr: 'التراخيص التشغيلية',
    hintAr: 'المهن، الطاقة، الدفاع المدني',
    descAr: 'كل ترخيص برقمه وتاريخ انتهائه؛ التواريخ تُغذّي نظام التنبيهات.',
  },
  {
    step: 5,
    titleAr: 'الحساب البنكي',
    hintAr: 'IBAN ومطابقة الاسم',
    descAr: 'الحساب الذي تُحوَّل إليه مستحقاتك، باسم مطابق للمنشأة أو المالك.',
  },
  {
    step: 6,
    titleAr: 'المرفقات',
    hintAr: 'الوثائق وصور الهوية',
    descAr: 'الوثائق الرسمية وصور الهوية من الوجهين.',
  },
];

export const FIELDS: CatalogField[] = [
  // ============ 1) هوية المنشأة ============
  {
    key: 'entityType',
    step: 1,
    labelAr: 'الصفة القانونية للمنشأة',
    hintAr: 'هذا الاختيار يحدد باقي الحقول المطلوبة ومن يحق له التوقيع.',
    kind: 'select',
    column: 'entityType',
    defaultMode: R,
    locked: true,
    options: [
      { value: 'SOLE_ESTABLISHMENT', labelAr: 'مؤسسة فردية' },
      { value: 'LLC', labelAr: 'شركة ذات مسؤولية محدودة' },
    ],
  },
  {
    key: 'legalNameAr',
    step: 1,
    labelAr: 'الاسم التجاري المسجّل',
    hintAr: 'لا الاسم الدارج — النص الحرفي كما في وثيقة التسجيل.',
    kind: 'text',
    column: 'legalNameAr',
    defaultMode: R,
    maxLength: 200,
  },
  {
    key: 'commercialRegistryNo',
    step: 1,
    labelAr: 'رقم السجل التجاري',
    hintAr: 'من وزارة الصناعة والتجارة والتموين.',
    kind: 'text',
    column: 'commercialRegistryNo',
    defaultMode: R,
    maxLength: 40,
  },
  {
    key: 'nationalEstablishmentNo',
    step: 1,
    labelAr: 'الرقم الوطني للمنشأة',
    hintAr: 'المعرّف الموحّد — به تُطابَق المنشأة عبر كل الجهات.',
    kind: 'text',
    column: 'nationalEstablishmentNo',
    defaultMode: R,
    maxLength: 40,
  },
  { key: 'registeredAt', step: 1, labelAr: 'تاريخ التسجيل', kind: 'date', column: 'registeredAt', defaultMode: R },
  {
    key: 'registryPlace',
    step: 1,
    labelAr: 'مكان التسجيل',
    hintAr: 'المحافظة / المديرية.',
    kind: 'text',
    column: 'registryPlace',
    defaultMode: R,
    maxLength: 120,
  },
  {
    key: 'officialEmail',
    step: 1,
    labelAr: 'بريد إلكتروني رسمي',
    hintAr: 'إليه تُرسل نسخة العقد وكل الإشعارات القانونية.',
    kind: 'email',
    column: 'officialEmail',
    defaultMode: R,
    maxLength: 160,
  },
  { key: 'addrGovernorate', step: 1, labelAr: 'المحافظة', kind: 'text', column: 'addrGovernorate', defaultMode: R, maxLength: 80 },
  { key: 'addrDistrict', step: 1, labelAr: 'اللواء', kind: 'text', column: 'addrDistrict', defaultMode: R, maxLength: 80 },
  { key: 'addrNeighborhood', step: 1, labelAr: 'الحي', kind: 'text', column: 'addrNeighborhood', defaultMode: R, maxLength: 80 },
  { key: 'addrStreet', step: 1, labelAr: 'الشارع', kind: 'text', column: 'addrStreet', defaultMode: R, maxLength: 120 },
  { key: 'addrBuildingNo', step: 1, labelAr: 'رقم البناية', kind: 'text', column: 'addrBuildingNo', defaultMode: R, maxLength: 20 },
  { key: 'addrPostalCode', step: 1, labelAr: 'ص.ب / الرمز البريدي', kind: 'text', column: 'addrPostalCode', defaultMode: O, maxLength: 20 },

  // ============ 2) الموقّع ============
  {
    key: 'ownerSigns',
    step: 2,
    labelAr: 'هل الموقّع هو المالك نفسه؟',
    hintAr: 'العقد يربط شخصاً بعينه. إن وقّع من ليس مفوّضاً، العقد قابل للطعن.',
    kind: 'bool',
    column: 'ownerSigns',
    defaultMode: R,
    locked: true,
  },
  {
    key: 'proxyNumber',
    step: 2,
    labelAr: 'رقم سند التفويض',
    kind: 'text',
    column: 'proxyNumber',
    defaultMode: R,
    maxLength: 60,
    showIf: needsProxy,
  },
  { key: 'proxyDate', step: 2, labelAr: 'تاريخ سند التفويض', kind: 'date', column: 'proxyDate', defaultMode: R, showIf: needsProxy },
  {
    key: 'signerName',
    step: 2,
    labelAr: 'الاسم الرباعي كما في الهوية',
    hintAr: 'الاسم الأول · الأب · الجد · العائلة.',
    kind: 'text',
    column: 'signerName',
    defaultMode: R,
    maxLength: 200,
  },
  { key: 'signerNationality', step: 2, labelAr: 'الجنسية', kind: 'text', column: 'signerNationality', defaultMode: R, maxLength: 60 },
  {
    key: 'signerNationalId',
    step: 2,
    labelAr: 'الرقم الوطني',
    hintAr: '١٠ خانات للأردني · رقم جواز أو إقامة لغير الأردني.',
    kind: 'nationalId',
    column: 'signerNationalId',
    defaultMode: R,
    maxLength: 30,
  },
  { key: 'signerPhone', step: 2, labelAr: 'هاتف شخصي', kind: 'phone', column: 'signerPhone', defaultMode: R, maxLength: 30 },
  { key: 'signerBirthDate', step: 2, labelAr: 'تاريخ الميلاد', kind: 'date', column: 'signerBirthDate', defaultMode: O },
  {
    key: 'signerRole',
    step: 2,
    labelAr: 'الصفة',
    kind: 'select',
    column: 'signerRole',
    defaultMode: R,
    options: [
      { value: 'OWNER', labelAr: 'مالك' },
      { value: 'GENERAL_MANAGER', labelAr: 'مدير عام' },
      { value: 'AUTHORIZED_SIGNATORY', labelAr: 'مفوّض بالتوقيع' },
    ],
  },

  // ============ 3) الوضع الضريبي ============
  {
    key: 'taxNumber',
    step: 3,
    labelAr: 'الرقم الضريبي',
    hintAr: 'من دائرة ضريبة الدخل والمبيعات.',
    kind: 'text',
    column: 'taxNumber',
    defaultMode: R,
    maxLength: 40,
  },
  {
    key: 'vatRegistered',
    step: 3,
    labelAr: 'مسجَّل في ضريبة المبيعات؟',
    hintAr: 'الرقم الضريبي ≠ رقم تسجيل ضريبة المبيعات — رقمان مختلفان من نفس الدائرة.',
    kind: 'bool',
    column: 'vatRegistered',
    defaultMode: R,
  },
  {
    key: 'vatNumber',
    step: 3,
    labelAr: 'رقم تسجيل ضريبة المبيعات',
    kind: 'text',
    column: 'vatNumber',
    defaultMode: R,
    maxLength: 40,
    showIf: isVat,
  },

  // ============ 5) الحساب البنكي ============
  { key: 'bankNameAr', step: 5, labelAr: 'اسم البنك', kind: 'text', column: 'bankNameAr', defaultMode: R, maxLength: 120 },
  { key: 'bankBranch', step: 5, labelAr: 'الفرع', kind: 'text', column: 'bankBranch', defaultMode: R, maxLength: 120 },
  {
    key: 'accountHolderName',
    step: 5,
    labelAr: 'اسم صاحب الحساب كما لدى البنك',
    hintAr: 'يجب أن يطابق اسم المنشأة أو المالك.',
    kind: 'text',
    column: 'accountHolderName',
    defaultMode: R,
    maxLength: 200,
  },
  { key: 'iban', step: 5, labelAr: 'IBAN', hintAr: 'يبدأ بـ JO · ٣٠ خانة.', kind: 'iban', column: 'iban', defaultMode: R, maxLength: 40 },
  {
    key: 'walletAlias',
    step: 5,
    labelAr: 'محفظة إلكترونية',
    hintAr: 'كليك / زين كاش — اختياري.',
    kind: 'text',
    column: 'walletAlias',
    defaultMode: O,
    maxLength: 80,
  },
];

/**
 * التراخيص. حالتها الافتراضية إلزامية لأن الأصل ألّا توزّع مياهاً بلا
 * ترخيص — لكنها كلها قابلة للتخفيف من اللوحة، فمن يجد أن الجهة لا تُصدر
 * ترخيصاً بعينه لصنف من الوكالات لا يحتاج نشر إصدار ليسجّلها.
 */
export const LICENSES: CatalogLicense[] = [
  { key: 'vocational', labelAr: 'رخصة المهن', authorityAr: 'أمانة عمّان / البلدية', defaultMode: R, expires: true },
  {
    key: 'lpgDistribution',
    labelAr: 'ترخيص توزيع المياه المسال',
    authorityAr: 'هيئة تنظيم قطاع الطاقة والمعادن',
    defaultMode: R,
    expires: true,
  },
  {
    key: 'civilDefense',
    labelAr: 'موافقة الدفاع المدني',
    authorityAr: 'الدفاع المدني — للمستودع ونقطة التعبئة',
    defaultMode: R,
    expires: true,
  },
  { key: 'supplier', labelAr: 'موافقة شركة المياه المورّدة', authorityAr: 'المورّد', defaultMode: O, expires: false },
];

export const DOCUMENTS: CatalogDocument[] = [
  { key: 'idFront', labelAr: 'الهوية الشخصية — الوجه الأمامي', hintAr: 'الأطراف الأربعة ظاهرة، بلا انعكاس ولا فلاتر.', defaultMode: R },
  { key: 'idBack', labelAr: 'الهوية الشخصية — الوجه الخلفي', hintAr: 'الأطراف الأربعة ظاهرة، بلا انعكاس ولا فلاتر.', defaultMode: R },
  { key: 'commercialRegistry', labelAr: 'صورة السجل التجاري', defaultMode: R },
  { key: 'vocationalLicense', labelAr: 'رخصة المهن السارية', defaultMode: R },
  { key: 'taxCertificate', labelAr: 'شهادة الرقم الضريبي', defaultMode: R },
  { key: 'lpgLicense', labelAr: 'ترخيص توزيع المياه المسال', defaultMode: R },
  { key: 'civilDefenseApproval', labelAr: 'موافقة الدفاع المدني', defaultMode: R },
  { key: 'ibanCertificate', labelAr: 'شهادة IBAN من البنك', defaultMode: R },
  { key: 'companyStamp', labelAr: 'صورة ختم المنشأة', hintAr: 'مفيد لمطابقة الختم على العقد الموقّع لاحقاً.', defaultMode: O },
  {
    key: 'articlesOfAssociation',
    labelAr: 'عقد التأسيس + شهادة المفوّضين بالتوقيع',
    hintAr: 'للشركات ذات المسؤولية المحدودة.',
    defaultMode: R,
    showIf: isLlc,
  },
  {
    key: 'signingAuthorization',
    labelAr: 'سند التفويض بالتوقيع',
    hintAr: 'حين لا يوقّع المالك بنفسه.',
    defaultMode: R,
    showIf: needsProxy,
  },
];

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
export const LICENSE_BY_KEY = new Map(LICENSES.map((l) => [l.key, l]));
export const DOCUMENT_BY_KEY = new Map(DOCUMENTS.map((d) => [d.key, d]));

/** كل مفاتيح الكتالوج — تُستعمل لرفض أي مفتاح مجهول قادم من اللوحة */
export const ALL_KEYS = new Set<string>([
  ...FIELDS.map((f) => `field:${f.key}`),
  ...LICENSES.map((l) => `license:${l.key}`),
  ...DOCUMENTS.map((d) => `doc:${d.key}`),
]);

export const requirementKey = {
  field: (k: string) => `field:${k}`,
  license: (k: string) => `license:${k}`,
  doc: (k: string) => `doc:${k}`,
};

// ============ التحقق من الصيغ ============
// تحققٌ شكليّ لا تحقّق من الوجود: لا نملك ربطاً بدوائر الدولة، وادّعاء
// التأكد ممّا لم نتأكد منه أسوأ من عدمه. الغاية منع الخطأ المطبعي الواضح
// وحده — والمراجع البشري هو من يطابق الرقم بصورة الوثيقة.

const JORDAN_NATIONAL_ID = /^\d{10}$/;
const PASSPORT_LIKE = /^[A-Za-z0-9]{5,20}$/;
const JORDAN_IBAN = /^JO\d{2}[A-Z0-9]{26}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const JORDAN_PHONE = /^(\+9627|009627|07)\d{8}$/;

/** يعيد رسالة الخطأ بالعربية، أو null إن كانت القيمة مقبولة شكلاً */
export function validateFieldValue(field: CatalogField, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (field.kind === 'bool') {
    return typeof raw === 'boolean' ? null : `${field.labelAr}: قيمة غير صالحة`;
  }

  if (field.kind === 'select') {
    const ok = field.options?.some((o) => o.value === raw);
    return ok ? null : `${field.labelAr}: خيار غير معروف`;
  }

  if (typeof raw !== 'string') return `${field.labelAr}: قيمة غير صالحة`;
  const v = raw.trim();

  if (field.maxLength && v.length > field.maxLength) {
    return `${field.labelAr}: أطول من ${field.maxLength} حرفاً`;
  }

  switch (field.kind) {
    case 'date':
      // YYYY-MM-DD وحده — لا نقبل تواريخ حرة يفسّرها كل نظام بطريقة
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
        ? null
        : `${field.labelAr}: تاريخ غير صالح`;
    case 'email':
      return EMAIL.test(v) ? null : `${field.labelAr}: بريد إلكتروني غير صالح`;
    case 'phone':
      return JORDAN_PHONE.test(v.replace(/[\s-]/g, ''))
        ? null
        : `${field.labelAr}: رقم أردني غير صالح (07XXXXXXXX أو ‎+9627XXXXXXXX)`;
    case 'nationalId':
      // الأردني عشر خانات؛ غير الأردني يحمل جوازاً أو إقامة بصيغة أخرى،
      // فنقبل الشكلين ونترك التمييز للمراجع أمام صورة الهوية.
      return JORDAN_NATIONAL_ID.test(v) || PASSPORT_LIKE.test(v)
        ? null
        : `${field.labelAr}: رقم غير صالح`;
    case 'iban':
      return JORDAN_IBAN.test(v.replace(/\s/g, '').toUpperCase())
        ? null
        : `${field.labelAr}: يجب أن يبدأ بـ JO ويتكوّن من ٣٠ خانة`;
    default:
      return null;
  }
}

/** تطبيع ما يُخزَّن: مسافات IBAN والهاتف ضجيج، وحروف IBAN تُرفع */
export function normalizeFieldValue(field: CatalogField, raw: string): string {
  const v = raw.trim();
  if (field.kind === 'iban') return v.replace(/\s/g, '').toUpperCase();
  if (field.kind === 'phone') return v.replace(/[\s-]/g, '');
  return v;
}
