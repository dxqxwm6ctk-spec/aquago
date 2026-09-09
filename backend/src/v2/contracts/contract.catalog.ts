/**
 * متغيّرات العقد — الجسر بين نصّ القالب وبيانات النظام.
 *
 * القالب نصٌّ يكتبه بشر ويراجعه محامٍ، فيه `{{مفتاح}}`. هذا الملف يقول ما
 * يعنيه كل مفتاح ومن أين يُملأ. مفتاحٌ في القالب لا وجود له هنا يُرفض عند
 * الحفظ لا عند التوليد: قالبٌ فيه متغيّر مجهول يُنتج عقداً فيه `{{...}}`
 * مطبوعة أمام صاحب وكالة يوقّعها.
 */

export interface ContractVariable {
  key: string;
  labelAr: string;
  /** من أين تأتي القيمة — للعرض في محرّر القالب */
  sourceAr: string;
  /** متغيّر لا يجوز أن يُترك فارغاً وقت التوليد */
  required?: boolean;
}

export const VARIABLES: ContractVariable[] = [
  // ---- العقد ----
  { key: 'contract.number', labelAr: 'رقم العقد', sourceAr: 'يُولَّد آلياً', required: true },
  { key: 'contract.date', labelAr: 'تاريخ العقد', sourceAr: 'تاريخ التوليد', required: true },
  { key: 'contract.startsAt', labelAr: 'تاريخ بدء الخدمة', sourceAr: 'تاريخ التفعيل' },
  { key: 'contract.endsAt', labelAr: 'تاريخ انتهاء العقد', sourceAr: 'محسوب من المدة' },

  // ---- الطرف الأول ----
  { key: 'platform.legalName', labelAr: 'الاسم القانوني للمنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.entityType', labelAr: 'نوع منشأة المنصة', sourceAr: 'إعدادات العقود' },
  { key: 'platform.nationalNo', labelAr: 'الرقم الوطني للمنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.registryNo', labelAr: 'السجل التجاري للمنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.taxNumber', labelAr: 'الرقم الضريبي للمنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.address', labelAr: 'عنوان المنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.signerName', labelAr: 'المفوّض بالتوقيع عن المنصة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'platform.signerRole', labelAr: 'صفة المفوّض عن المنصة', sourceAr: 'إعدادات العقود', required: true },

  // ---- الطرف الثاني: من ملف المنشأة المعتمد ----
  { key: 'agency.legalName', labelAr: 'الاسم القانوني للوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.entityType', labelAr: 'الصفة القانونية للوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.nationalNo', labelAr: 'الرقم الوطني للوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.registryNo', labelAr: 'السجل التجاري للوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.taxNumber', labelAr: 'الرقم الضريبي للوكالة', sourceAr: 'ملف المنشأة' },
  { key: 'agency.address', labelAr: 'عنوان الوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.signerName', labelAr: 'المفوّض بالتوقيع عن الوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.signerRole', labelAr: 'صفة المفوّض عن الوكالة', sourceAr: 'ملف المنشأة', required: true },
  { key: 'agency.tradeName', labelAr: 'اسم الوكالة الدارج', sourceAr: 'سجل الوكالة', required: true },

  // ---- الشروط ----
  { key: 'terms.termMonths', labelAr: 'مدة العقد بالأشهر', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.renewNoticeDays', labelAr: 'مهلة إشعار عدم التجديد', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.terminationNoticeDays', labelAr: 'مهلة إشعار الإنهاء', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.commissionNoticeDays', labelAr: 'مهلة إشعار تعديل العمولة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.legacyGraceDays', labelAr: 'مهلة الوكالات القائمة', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.wetCopyDueDays', labelAr: 'مهلة النسخة الورقية', sourceAr: 'إعدادات العقود', required: true },
  { key: 'terms.jurisdiction', labelAr: 'نص جهة فض النزاع', sourceAr: 'إعدادات العقود — من المحامي', required: true },
  { key: 'terms.stampDuty', labelAr: 'نص رسوم الطوابع', sourceAr: 'إعدادات العقود' },

  // ---- التفاصيل التجارية (المادة ٤١) ----
  { key: 'deal.subscription', labelAr: 'الاشتراك الشهري', sourceAr: 'اشتراك الوكالة', required: true },
  { key: 'deal.subscriptionBox', labelAr: 'خانتا خاضع/معفى', sourceAr: 'محسوب من الاشتراك', required: true },
  { key: 'deal.branchName', labelAr: 'اسم الفرع', sourceAr: 'الفرع الرئيسي' },
  { key: 'deal.serviceArea', labelAr: 'نطاق الخدمة', sourceAr: 'تغطية الوكالة' },
  { key: 'deal.driversCount', labelAr: 'عدد السائقين عند التفعيل', sourceAr: 'سائقو الوكالة' },
  { key: 'deal.verificationStatus', labelAr: 'حالة التحقق', sourceAr: 'ملف المنشأة' },
];

export const VARIABLE_KEYS = new Set(VARIABLES.map((v) => v.key));
export const REQUIRED_KEYS = VARIABLES.filter((v) => v.required).map((v) => v.key);

/** كل `{{...}}` داخل نصّ — للتحقق من القالب عند حفظه */
export function extractPlaceholders(body: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9._]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) found.add(m[1]);
  return [...found];
}

/**
 * التعبئة. القيم تُهرَّب دائماً — القالب HTML، واسم وكالة فيه `<` كان
 * سيكسر الوثيقة أو يحقن وسماً في عقد موقّع.
 */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9._]+)\s*\}\}/g, (whole, key: string) => {
    const v = values[key];
    return v === undefined ? whole : escapeHtml(v);
  });
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
