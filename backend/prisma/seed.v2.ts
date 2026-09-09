/**
 * Seed v2 — Jordan Gas Platform (وثيقة التصميم docs/03-database-design-v1.md §5)
 * تشغيل: npm run v2:deploy ثم npm run v2:seed
 *
 * يزرع: قيود SQL اليدوية، الصلاحيات، الأدوار السبعة، DispatchSettings،
 * عمّان بمناطقها (polygons)، أنواع القوارير، ووكالة تجريبية كاملة.
 */
process.env.DATABASE_URL_V2 ??=
  'postgresql://gas:gas_secret@localhost:5433/jordan_gas_v2?schema=public';

import { PrismaClient, RoleScope } from '@prisma-v2/client';
import { hashPassword } from '../src/v2/auth/password.util';

const prisma = new PrismaClient();

// ============ 1) قيود لا يعبّر عنها Prisma — idempotent ============

async function applyManualConstraints() {
  // عرض PENDING واحد فقط لكل طلب — يمنع قبول سائقَين لنفس الطلب
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_offer_per_order
      ON "DriverOffer" ("orderId") WHERE status = 'PENDING'
  `);
  // فهارس مكانية لاستعلام "أي حي/منطقة تحتوي موقع الزبون؟"
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS zone_geom_gist ON "Zone" USING GIST (geom)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS neighborhood_geom_gist ON "Neighborhood" USING GIST (geom)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS district_geom_gist ON "District" USING GIST (geom)
  `);
  // السجل المالي لا يُعدَّل ولا يُحذف — Trigger يرمي استثناءً.
  // (ليس RULE: قواعد DO INSTEAD NOTHING تكسر فحوص المفاتيح الأجنبية الداخلية)
  await prisma.$executeRawUnsafe(`DROP RULE IF EXISTS ledger_no_update ON "LedgerEntry"`);
  await prisma.$executeRawUnsafe(`DROP RULE IF EXISTS ledger_no_delete ON "LedgerEntry"`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'LedgerEntry append-only: % غير مسموح', TG_OP;
    END; $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ledger_no_update ON "LedgerEntry"`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ledger_no_update BEFORE UPDATE ON "LedgerEntry"
      FOR EACH ROW EXECUTE FUNCTION ledger_immutable()
  `);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ledger_no_delete ON "LedgerEntry"`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ledger_no_delete BEFORE DELETE ON "LedgerEntry"
      FOR EACH ROW EXECUTE FUNCTION ledger_immutable()
  `);
  console.log('✅ القيود اليدوية (partial unique + GIST + ledger rules)');
}

// ============ 2) الصلاحيات ============

const PERMISSIONS: Record<string, string> = {
  // وكالة
  'orders.view': 'عرض طلبات الوكالة',
  'orders.assign': 'تعيين سائق يدوياً',
  'orders.cancel': 'إلغاء طلب',
  'orders.transfer': 'نقل طلب',
  'drivers.view': 'عرض السائقين',
  'drivers.create': 'إضافة سائق',
  'drivers.update': 'تعديل سائق',
  'drivers.suspend': 'إيقاف سائق',
  'employees.view': 'عرض الموظفين',
  'employees.create': 'إضافة موظف',
  'employees.update': 'تعديل موظف وصلاحياته',
  'employees.disable': 'تعطيل موظف',
  'wallet.view': 'عرض المحفظة وكشف الحساب',
  'wallet.recharge': 'طلب شحن رصيد للوكالة',
  'wallet.topup': 'اعتماد طلبات الشحن (مالية المنصة)',
  'coverage.manage': 'إدارة مناطق التغطية',
  'hours.manage': 'إدارة ساعات العمل والإجازات',
  'availability.manage': 'إدارة توفر القوارير',
  'reports.view': 'عرض التقارير',
  'agency.settings': 'إعدادات الوكالة و Auto Dispatch',
  'agency.onboarding.manage': 'تعبئة ملف المنشأة وإرساله للمراجعة',
  // العرض منفصل عن التوقيع: موظف يتابع مدة العقد ليس بالضرورة من يلزم
  // الوكالة بتوقيعه
  'agency.contracts.view': 'عرض عقد الوكالة وتحميله',
  'agency.contracts.sign': 'توقيع العقد ورفع نسخته الورقية',
  // منصة
  'platform.agencies.manage': 'إدارة الوكالات',
  'platform.agencies.approve': 'اعتماد/إيقاف وكالة',
  'platform.cities.manage': 'إدارة المدن',
  'platform.zones.manage': 'إدارة المناطق وحدودها',
  'platform.bottles.manage': 'إدارة أنواع القوارير',
  'platform.dispatch.settings': 'أوزان ومهلات التوزيع',
  'platform.otp.channel': 'قناة إرسال رمز التحقق (واتساب/بريد)',
  'platform.users.manage': 'إدارة المستخدمين',
  'platform.finance.manage': 'المالية: أرصدة وحركات',
  'platform.tickets.manage': 'إدارة الشكاوى والتذاكر',
  'platform.reports.view': 'تقارير المنصة',
  'platform.audit.view': 'سجل التدقيق',
  'platform.banners.manage': 'إدارة البانرات الترويجية',
  'platform.notifications.send': 'إرسال إشعار مخصص لفئة مستخدمين',
  'platform.coupons.manage': 'إدارة كوبونات الخصم',
  'platform.invoices.manage': 'إعدادات الفواتير وهويتها',
  'platform.appversion.manage': 'إدارة نسخة التطبيق والتحديث الإجباري',
  // باب دخول بلا تحقق: صلاحية منفصلة عن بقية إعدادات التطبيق عمداً، فمن
  // يضبط حدّ النسخة ليس بالضرورة من يُؤتمن على فتح حساب يتجاوز رمز التحقق
  'platform.reviewaccount.manage': 'إدارة حساب مراجعة المتجر (دخول بلا رمز)',
  'platform.orders.numbering': 'ترقيم الطلبات وتصفير العدّاد',
  // وحدة الوكالات المحتملة والتواصل — الإدارة منفصلة عن الاعتماد، والإرسال
  // منفصل عن إنشاء الحملة: من يكتب نصاً ليس بالضرورة من يطلقه على آلاف الناس
  'platform.leads.manage': 'إدارة الوكالات المحتملة واستيرادها',
  'platform.leads.approve': 'اعتماد/رفض/إيقاف وكالة محتملة',
  'platform.campaigns.manage': 'إنشاء ومتابعة حملات واتساب',
  'platform.campaigns.send': 'بدء واستئناف إرسال الحملات',
  // ملف المنشأة — المراجعة منفصلة عن ضبط ما يُطلب: من يقرأ هوية صاحب وكالة
  // ويعتمد ملفه ليس بالضرورة من يقرّر أن الرقم الضريبي صار إلزامياً على
  // كل الوكالات. الأولى عملٌ يومي، والثانية قرار سياسة يمسّ الجميع.
  'platform.onboarding.review': 'مراجعة ملفات المنشآت واعتمادها',
  'platform.onboarding.settings': 'ضبط الحقول والمرفقات المطلوبة من الوكالات',
  // التوليد والمتابعة عملٌ يومي؛ التوقيع المقابل يُلزم الشركة، وتحرير
  // القالب يغيّر نصّ كل عقد قادم. ثلاث صلاحيات لا واحدة.
  'platform.contracts.manage': 'توليد العقود ومتابعتها ومراجعة نسخها الورقية',
  'platform.contracts.sign': 'التوقيع عن المنصة وإنهاء العقود',
  'platform.contracts.settings': 'تحرير قالب العقد وإعدادات التعاقد',
};

// ============ 3) الأدوار السبعة المعتمدة ============

const pf = (keys: string[]) => keys; // وضوح فقط

const ROLES: {
  name: string;
  nameAr: string;
  scope: RoleScope;
  perms: string[] | 'ALL';
}[] = [
  { name: 'SUPER_ADMIN', nameAr: 'المدير الأعلى', scope: 'PLATFORM', perms: 'ALL' },
  // نفس صلاحيات المدير الأعلى، ودورٌ منفصل عنه عمداً: SUPER_ADMIN محميّ من
  // التعطيل والحذف من اللوحة، فيبقى حسابٌ واحد لا يستطيع أحدٌ إقفال الباب
  // دونه. ADMIN يُمنح ويُسحب كأي دور — سلطة كاملة بلا حصانة.
  { name: 'ADMIN', nameAr: 'مدير', scope: 'PLATFORM', perms: 'ALL' },
  {
    name: 'OPERATIONS', nameAr: 'التشغيل', scope: 'PLATFORM',
    perms: pf(['platform.tickets.manage', 'orders.view', 'orders.transfer', 'platform.reports.view', 'platform.zones.manage', 'platform.notifications.send', 'platform.coupons.manage', 'platform.leads.manage', 'platform.campaigns.manage', 'platform.onboarding.review', 'platform.contracts.manage']),
  },
  {
    name: 'SUPPORT', nameAr: 'الدعم', scope: 'PLATFORM',
    perms: pf(['platform.tickets.manage', 'orders.view']),
  },
  {
    name: 'ACCOUNTANT', nameAr: 'المحاسب', scope: 'PLATFORM',
    perms: pf(['platform.finance.manage', 'wallet.topup', 'wallet.view', 'platform.reports.view']),
  },
  {
    name: 'AGENCY_OWNER', nameAr: 'صاحب الوكالة', scope: 'AGENCY',
    perms: pf([
      'orders.view', 'orders.assign', 'orders.cancel', 'orders.transfer',
      'drivers.view', 'drivers.create', 'drivers.update', 'drivers.suspend',
      'employees.view', 'employees.create', 'employees.update', 'employees.disable',
      'wallet.view', 'wallet.recharge', 'coverage.manage', 'hours.manage', 'availability.manage',
      'reports.view', 'agency.settings', 'agency.onboarding.manage',
      'agency.contracts.view', 'agency.contracts.sign',
    ]),
  },
  // قالب فارغ — المالك يمنح ما يشاء لكل موظف
  { name: 'AGENCY_EMPLOYEE', nameAr: 'موظف وكالة', scope: 'AGENCY', perms: [] },
  { name: 'DRIVER', nameAr: 'سائق', scope: 'AGENCY', perms: pf(['orders.view']) },
];

// ============ 4) مناطق عمّان (المراكز من بيانات الـ MVP، الحدود دوائر مبدئية) ============
// ملاحظة: هذه polygons مبدئية نصف قطرها 2كم — تُستبدل برسم فعلي من لوحة المنصة

const AMMAN_ZONES = [
  { nameAr: 'عبدون الشمالي', lat: 31.9515, lng: 35.8777, district: 'زهران', neighborhood: 'عبدون' },
  { nameAr: 'دابوق', lat: 31.9905, lng: 35.8285, district: 'وادي السير', neighborhood: 'دابوق' },
  { nameAr: 'الرابية', lat: 31.9927, lng: 35.8672, district: 'تلاع العلي', neighborhood: 'الرابية' },
  { nameAr: 'طبربور', lat: 32.0128, lng: 35.9231, district: 'طارق', neighborhood: 'طبربور' },
  { nameAr: 'الجاردنز', lat: 31.9789, lng: 35.8706, district: 'تلاع العلي', neighborhood: 'الجاردنز' },
  { nameAr: 'الجبيهة', lat: 32.0203, lng: 35.8722, district: 'الجبيهة', neighborhood: 'الجبيهة' },
  { nameAr: 'تلاع العلي', lat: 31.9899, lng: 35.8555, district: 'تلاع العلي', neighborhood: 'تلاع العلي' },
  { nameAr: 'جبل عمان', lat: 31.9508, lng: 35.9206, district: 'زهران', neighborhood: 'جبل عمان' },
];

async function main() {
  await applyManualConstraints();

  const already = await prisma.city.findUnique({ where: { nameAr: 'عمّان' } });
  if (already) {
    console.log('ℹ️ البيانات مزروعة مسبقاً — استكمال ضمانات الوكالات فقط');
    await backfillAmmanDistricts();
    await backfillAgencies();
    await backfillStaffCredentials();
    await backfillPermissions();
    return;
  }

  // ---- الصلاحيات والأدوار ----
  const permByKey = new Map<string, string>();
  for (const [key, descAr] of Object.entries(PERMISSIONS)) {
    const p = await prisma.permission.create({ data: { key, descAr } });
    permByKey.set(key, p.id);
  }
  const roleByName = new Map<string, string>();
  for (const r of ROLES) {
    const keys = r.perms === 'ALL' ? [...permByKey.keys()] : r.perms;
    const role = await prisma.role.create({
      data: {
        name: r.name,
        nameAr: r.nameAr,
        scope: r.scope,
        isSystem: true,
        permissions: {
          create: keys.map((k) => ({ permissionId: permByKey.get(k)! })),
        },
      },
    });
    roleByName.set(r.name, role.id);
  }
  console.log(`✅ ${permByKey.size} صلاحية، ${roleByName.size} أدوار نظام`);

  // ---- إعدادات التوزيع (الأوزان الافتراضية من القرار المعتمد) ----
  await prisma.dispatchSettings.create({ data: { id: 1 } });
  await prisma.orderCounter.create({ data: { id: 1 } });

  // ---- الجغرافيا: عمّان + مناطقها ----
  const amman = await prisma.city.create({
    data: { nameAr: 'عمّان', nameEn: 'Amman', active: true },
  });
  // التسلسل الإداري: منطقة ← حي، ثم منطقة التغطية تُربط بالحي
  const districtByName = new Map<string, string>();
  const neighborhoodByName = new Map<string, string>();
  for (const z of AMMAN_ZONES) {
    if (!districtByName.has(z.district)) {
      const d = await prisma.district.create({ data: { cityId: amman.id, nameAr: z.district } });
      districtByName.set(z.district, d.id);
    }
    if (!neighborhoodByName.has(z.neighborhood)) {
      const n = await prisma.neighborhood.create({
        data: { districtId: districtByName.get(z.district)!, nameAr: z.neighborhood },
      });
      neighborhoodByName.set(z.neighborhood, n.id);
    }
  }

  const zoneIds: string[] = [];
  for (const z of AMMAN_ZONES) {
    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "Zone" (id, "cityId", "neighborhoodId", "nameAr", active, geom)
      VALUES (${id}, ${amman.id}, ${neighborhoodByName.get(z.neighborhood)!}, ${z.nameAr}, true,
        ST_Buffer(ST_SetSRID(ST_MakePoint(${z.lng}, ${z.lat}), 4326)::geography, 2000)::geometry)
    `;
    zoneIds.push(id);
  }
  console.log(`✅ عمّان + ${districtByName.size} مناطق إدارية + ${neighborhoodByName.size} أحياء + ${zoneIds.length} مناطق تغطية`);

  // ---- أنواع قوارير المياه (تديرها المنصة) ----
  //
  // الثلاثة مطابقة لكتالوج التصميم (Aqua Go.dc.html) اسمًا وسعرًا:
  // ما يراه الزبون في التطبيق هو ما تبذره القاعدة، فلا تختلف بيئة
  // التطوير عن الشاشة التي بُنيت عليها.
  const bottle18 = await prisma.waterBottleType.create({
    data: { nameAr: 'قارورة مياه 18.9 لتر', sizeLiters: 18.9, price: 2.5, sort: 1 },
  });
  const pack5 = await prisma.waterBottleType.create({
    data: { nameAr: 'عبوة 4×5 لتر', sizeLiters: 20, price: 1.75, sort: 2 },
  });
  const carton15 = await prisma.waterBottleType.create({
    data: { nameAr: 'كرتونة 12×1.5 لتر', sizeLiters: 18, price: 2.2, sort: 3 },
  });

  // ---- مستخدمو المنصة ----
  const superAdmin = await prisma.user.create({
    data: { phone: '+962790000001', name: 'أحمد المحمد' },
  });
  const accountant = await prisma.user.create({
    data: { phone: '+962790000002', name: 'رنا العمري' },
  });
  await prisma.userRole.create({
    data: { userId: superAdmin.id, roleId: roleByName.get('SUPER_ADMIN')! },
  });
  await prisma.userRole.create({
    data: { userId: accountant.id, roleId: roleByName.get('ACCOUNTANT')! },
  });

  // ---- وكالة تجريبية: مالك، فرع، تغطية، ساعات، توفر، محفظة ----
  const owner = await prisma.user.create({
    data: { phone: '+962790000010', name: 'سميح أبو غزالة' },
  });
  const agency = await prisma.agency.create({
    data: {
      cityId: amman.id,
      nameAr: 'وكالة مياه الوحدات',
      phone: '+96264777777',
      status: 'ACTIVE',
      autoDispatch: true, // لاختبار محرك التوزيع في المرحلة 3
    },
  });
  await prisma.userRole.create({
    data: { userId: owner.id, roleId: roleByName.get('AGENCY_OWNER')!, agencyId: agency.id },
  });
  const branch = await prisma.agencyBranch.create({
    data: {
      agencyId: agency.id,
      nameAr: 'المستودع الرئيسي — ماركا',
      lat: 31.9825,
      lng: 35.9819,
      deliveryRadiusKm: 12, // يغطي معظم عمّان لبيانات التجربة
      isMain: true,
    },
  });
  // التغطية تُحسب بنطاق الفرع (deliveryRadiusKm) — لا صفوف تغطية إدارية.
  // ولا ساعات عمل: الوكالة تعمل على مدار الساعة وتغلق بقرارها وحدها.
  await prisma.agencyBottleAvailability.createMany({
    data: [
      { agencyId: agency.id, bottleTypeId: bottle18.id, available: true },
      { agencyId: agency.id, bottleTypeId: pack5.id, available: true },
      { agencyId: agency.id, bottleTypeId: carton15.id, available: true },
    ],
  });
  // محفظة مشحونة 100 دينار (شحن يدوي من المحاسب — نموذج Prepaid)
  const wallet = await prisma.wallet.create({
    data: { agencyId: agency.id, balance: 100 },
  });
  await prisma.ledgerEntry.create({
    data: {
      walletId: wallet.id,
      type: 'TOPUP',
      amount: 100,
      balanceAfter: 100,
      reference: 'حوالة بنكية تجريبية',
      noteAr: 'شحن رصيد افتتاحي',
      actorUserId: accountant.id,
    },
  });

  // ---- سائقان للوكالة ----
  const driverRole = roleByName.get('DRIVER')!;
  for (const d of [
    { phone: '+962790000011', name: 'أحمد الزعبي', plate: '22-78901' },
    { phone: '+962790000012', name: 'خليل عسّاف', plate: '22-78902' },
  ]) {
    const u = await prisma.user.create({ data: { phone: d.phone, name: d.name } });
    await prisma.userRole.create({
      data: { userId: u.id, roleId: driverRole, agencyId: agency.id },
    });
    await prisma.driverProfile.create({
      data: {
        userId: u.id,
        agencyId: agency.id,
        branchId: branch.id,
        isVerified: true,
        vehiclePlate: d.plate,
        status: 'AVAILABLE',
        currentLat: branch.lat,
        currentLng: branch.lng,
      },
    });
  }

  // ---- زبون تجريبي بعنوان داخل منطقة "جبل عمان" ----
  const customer = await prisma.user.create({
    data: { phone: '+962791111111', name: 'زيد الحوراني' },
  });
  await prisma.address.create({
    data: {
      userId: customer.id,
      label: 'المنزل',
      street: 'شارع الرينبو',
      building: '45',
      floor: 'الثالث',
      lat: 31.9508,
      lng: 35.9206,
      isDefault: true,
    },
  });

  console.log('🌱 Seed v2 اكتمل: صلاحيات، أدوار، عمّان، وكالة كاملة، سائقان، زبون');
  await backfillAmmanDistricts();
  await backfillAgencies();
  await backfillStaffCredentials();
  await backfillPermissions();
}

/**
 * مناطق أمانة عمّان الكبرى الاثنتان والعشرون.
 *
 * البذرة الأصلية زرعت خمساً فقط — تلك التي احتاجتها مناطق التغطية التجريبية
 * (زهران، وادي السير، تلاع العلي، طارق، الجبيهة). فبقيت «مرج الحمام»
 * و«المقابلين» و«القويسمة» وسبع عشرة غيرها غائبة عن قائمة المناطق كلها،
 * ومعها كل وكالة تقع فيها: تُحفظ باسم منطقة نصّي و`areaId = null` لأن لا
 * منطقة تقابلها.
 *
 * المصدر: صفحة «معلومات اتصال المناطق» على موقع أمانة عمّان الكبرى
 * https://media.ammancity.gov.jo/AR/List/معلومات_اتصال_المناطق
 * لا اجتهاد ولا تخمين — أسماء رسمية تُنسخ كما هي.
 */
async function backfillAmmanDistricts() {
  const amman = await prisma.city.findUnique({ where: { nameAr: 'عمّان' } });
  if (!amman) return;

  const DISTRICTS = [
    'المدينة', 'بسمان', 'ماركا', 'النصر', 'اليرموك', 'رأس العين',
    'بدر نزال', 'زهران', 'العبدلي', 'طارق', 'القويسمة', 'خريبة السوق',
    'المقابلين', 'وادي السير', 'بدر الجديدة', 'صويلح', 'تلاع العلي',
    'الجبيهة', 'شفا بدران', 'أبو نصير', 'أحد', 'مرج الحمام',
  ];

  const existing = await prisma.district.findMany({
    where: { cityId: amman.id },
    select: { nameAr: true },
  });
  // المقارنة بعد تطبيع خفيف: القاعدة قد تحمل «الجبيهه» والقائمة «الجبيهة»،
  // وإنشاء الثانية يصنع منطقتين لمكان واحد
  const norm = (v: string) =>
    v.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  const have = new Set(existing.map((d) => norm(d.nameAr)));

  const missing = DISTRICTS.filter((d) => !have.has(norm(d)));
  if (!missing.length) return;

  await prisma.district.createMany({
    data: missing.map((nameAr) => ({ cityId: amman.id, nameAr })),
    skipDuplicates: true,
  });
  console.log(`🗺️  أُضيفت ${missing.length} منطقة من مناطق أمانة عمّان: ${missing.join('، ')}`);
}

/**
 * الصلاحيات والأدوار تُزرع مرة واحدة عند أول تشغيل، فأي مفتاح جديد يُضاف
 * لاحقاً (مثل wallet.recharge) لا يصل قواعد قائمة — فيرد الحارس 403 على
 * ميزة موجودة في الكود. هذا الـ backfill يزرع الناقص عند كل إقلاع:
 * يضيف المفاتيح الجديدة ويربطها بأدوار النظام حسب تعريف ROLES، ولا يمس
 * الأدوار المخصصة التي منحها أصحاب الوكالات لموظفيهم.
 */
async function backfillPermissions() {
  const existing = await prisma.permission.findMany();
  const byKey = new Map(existing.map((p) => [p.key, p.id]));
  const added: string[] = [];
  for (const [key, descAr] of Object.entries(PERMISSIONS)) {
    if (byKey.has(key)) continue;
    const p = await prisma.permission.create({ data: { key, descAr } });
    byKey.set(key, p.id);
    added.push(key);
  }

  let links = 0;
  const createdRoles: string[] = [];
  for (const r of ROLES) {
    // دورٌ أُضيف بعد أول زرع: كان يُتخطّى بصمت (`continue`) فلا يوجد أبداً
    // على قاعدة عاملة — البذرة الكاملة لا تعمل إلا على قاعدة فارغة.
    let role = await prisma.role.findFirst({
      where: { name: r.name, isSystem: true, agencyId: null },
    });
    if (!role) {
      role = await prisma.role.create({
        data: { name: r.name, nameAr: r.nameAr, scope: r.scope, isSystem: true },
      });
      createdRoles.push(r.name);
    }
    const keys = r.perms === 'ALL' ? [...byKey.keys()] : r.perms;
    const held = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    });
    const heldIds = new Set(held.map((h) => h.permissionId));
    const missing = keys
      .map((k) => byKey.get(k))
      .filter((id): id is string => !!id && !heldIds.has(id));
    if (missing.length) {
      await prisma.rolePermission.createMany({
        data: missing.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
      links += missing.length;
    }
  }
  if (createdRoles.length) console.log(`👤 أدوار جديدة: ${createdRoles.join('، ')}`);
  if (added.length || links) {
    console.log(`🔐 صلاحيات جديدة: ${added.join('، ') || 'لا شيء'} — ${links} ربطاً بأدوار النظام`);
  }
}

/**
 * فصل وسائل الدخول: حسابات اللوحات (منصة + وكالة، عدا السائق) تحتاج اسم
 * مستخدم وكلمة مرور. الحسابات التي أُنشئت قبل هذا الفصل كانت تدخل بالـ OTP
 * وحده — بدون هذا الـ backfill تُقفل خارج لوحاتها. اسم المستخدم الافتراضي
 * هو الهاتف بصيغته المحلية (فريد أصلاً)، وكلمة المرور مؤقتة تُغيَّر أول دخول.
 *
 * ثلاثة قيود مقصودة:
 *  1. لا يمس إلا حساباً بلا اسم مستخدم **وبلا** كلمة مرور — من غيّر كلمته
 *     لا يُعاد ضبطها عند كل إقلاع.
 *  2. لا تُطبع كلمة المرور في السجل أبداً (سجلات الاستضافة محفوظة ومرئية).
 *  3. في production لا كلمة افتراضية: بلا STAFF_MIGRATION_PASSWORD يتوقف
 *     الـ backfill ويطلبها بدل زرع كلمة معروفة في الكود.
 */
async function backfillStaffCredentials() {
  const configured =
    process.env.STAFF_MIGRATION_PASSWORD || process.env.STAFF_DEFAULT_PASSWORD;
  const isProd = process.env.NODE_ENV === 'production';
  const staff = await prisma.user.findMany({
    where: {
      username: null,
      passwordHash: null,
      roles: {
        some: {
          OR: [
            { role: { scope: 'PLATFORM' } },
            { role: { scope: 'AGENCY', name: { not: 'DRIVER' } } },
          ],
        },
      },
    },
    select: { id: true, name: true, phone: true },
  });
  if (staff.length === 0) return;

  if (isProd && !configured) {
    console.warn(
      `⚠️ ${staff.length} حساب لوحة بلا بيانات دخول. اضبط STAFF_MIGRATION_PASSWORD` +
        ' في متغيرات البيئة ثم أعد النشر — لا تُزرع كلمة مرور افتراضية في الإنتاج.',
    );
    return;
  }
  const passwordHash = await hashPassword(configured || 'Aqua@12345');
  const created: string[] = [];
  for (const u of staff) {
    // 0790000001 من +962790000001 — قابل للإملاء على الهاتف ومضمون التفرد
    const local = u.phone ? u.phone.replace(/^\+962/, '0') : null;
    const username = local || `user-${u.id.slice(0, 8)}`;
    if (await prisma.user.findFirst({ where: { username } })) continue;
    await prisma.user.update({
      where: { id: u.id },
      data: { username, passwordHash, mustChangePassword: true },
    });
    created.push(`${username} (${u.name})`);
  }
  if (created.length) {
    // أسماء المستخدمين فقط — الكلمة تُقرأ من متغير البيئة لا من السجل
    console.log(
      `🔑 أُنشئت بيانات دخول اللوحات لـ ${created.length} حساب (كلمة المرور من ` +
        `${configured ? 'STAFF_MIGRATION_PASSWORD' : 'القيمة الافتراضية للتطوير'}` +
        `، وتُغيَّر إلزامياً أول دخول):\n   ${created.join('\n   ')}`,
    );
  }
}

/**
 * ضمانات تعمل عند كل إقلاع (idempotent) لأي وكالة أُنشئت بنسخة أقدم:
 * - فرع رئيسي إن لم يوجد (التغطية والتوزيع مربوطان بالفرع)
 * - سجل توفر لكل صنف نشط (غيابه = تخطٍّ من محرك التوزيع وصفحة توفر فارغة)
 */
/**
 * إضافة وزن جديد لصف إعدادات موجود تجعل المجموع ≠ 1.0، فيرفض السيرفر أي حفظ
 * لاحق (تحقق المجموع). نعيد الأوزان إلى الافتراضيات المتوازنة مرة واحدة.
 */
async function normalizeDispatchWeights() {
  const s = await prisma.dispatchSettings.upsert({
    where: { id: 1 }, create: { id: 1 }, update: {},
  });
  const sum =
    Number(s.distanceWeight) + Number(s.availabilityWeight) +
    Number(s.driverAvailabilityWeight) + Number(s.loadWeight) +
    Number(s.ratingWeight) + Number(s.responseRateWeight);
  if (Math.abs(sum - 1) > 0.001) {
    await prisma.dispatchSettings.update({
      where: { id: 1 },
      data: {
        distanceWeight: 0.35, availabilityWeight: 0.20,
        driverAvailabilityWeight: 0.20, loadWeight: 0.10,
        ratingWeight: 0.10, responseRateWeight: 0.05,
      },
    });
    console.log(`⚖️ أُعيد توازن أوزان التوزيع (كان المجموع ${sum.toFixed(3)})`);
  }
}

/**
 * عدّاد أرقام الطلبات — بلا صفّه لا يُنشأ طلب. يبدأ من 1: رموز الطلبات
 * القديمة كانت عشوائية من ستة أرقام، والجديدة متسلسلة بخمسة، وما تصادف منها
 * يتخطّاه المولّد.
 */
async function ensureOrderCounter() {
  await prisma.orderCounter.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
  // المتتالية مصدر الأرقام الفعلي (migrations/2_order_code_sequence).
  // تُنشأ هنا أيضاً لمسار `db push` الذي لا يشغّل الهجرات — وبلا هذا
  // يفشل أول طلب على قاعدة تطوير جديدة بـ«relation does not exist».
  // idempotent: لا تلمس متتالية قائمة ولا تُرجعها إلى الخلف.
  await prisma.$executeRawUnsafe(
    `DO $$
     DECLARE max_used bigint := 0;
     BEGIN
       SELECT coalesce(max(NULLIF(regexp_replace(code, '^[A-Z]+-', ''), '')::bigint), 0)
         INTO max_used FROM "Order" WHERE code ~ '^[A-Z]+-[0-9]+$';
       IF to_regclass('order_code_seq') IS NULL THEN
         EXECUTE format(
           'CREATE SEQUENCE order_code_seq AS bigint START WITH %s MINVALUE 1',
           greatest(max_used + 1, 1));
       END IF;
     END $$;`,
  );
}

async function backfillAgencies() {
  await normalizeDispatchWeights();
  await ensureOrderCounter();
  const [agencies, types] = await Promise.all([
    prisma.agency.findMany({ include: { branches: { select: { id: true } } } }),
    prisma.waterBottleType.findMany({ where: { active: true }, select: { id: true } }),
  ]);
  for (const agency of agencies) {
    if (agency.branches.length === 0) {
      const [center] = await prisma.$queryRaw<
        { lat: number | null; lng: number | null }[]
      >`
        SELECT ST_Y(ST_Centroid(ST_Collect(geom))) AS lat,
               ST_X(ST_Centroid(ST_Collect(geom))) AS lng
        FROM "Zone" WHERE "cityId" = ${agency.cityId} AND active = true
      `;
      await prisma.agencyBranch.create({
        data: {
          agencyId: agency.id,
          nameAr: 'الفرع الرئيسي',
          lat: center?.lat ?? 31.9539,
          lng: center?.lng ?? 35.9106,
          isMain: true,
        },
      });
      console.log(`🏪 فرع رئيسي افتراضي للوكالة: ${agency.nameAr} — تُصحح إحداثياته ونطاقه من لوحتها`);
    }
    // skipDuplicates يحافظ على اختيارات "غير متوفر" الموجودة
    await prisma.agencyBottleAvailability.createMany({
      data: types.map((t) => ({
        agencyId: agency.id,
        bottleTypeId: t.id,
        available: true,
      })),
      skipDuplicates: true,
    });
  }
  // انتقال من التغطية بالحدود الإدارية إلى النطاق: وكالة كانت تغطي مناطق
  // كاملة لا يجوز أن تنكمش فجأة إلى 5كم — نمنحها 10كم حتى تضبط نطاقها بنفسها
  const legacyCovered = await prisma.agencyCoverage.findMany({
    select: { branchId: true },
    distinct: ['branchId'],
  });
  if (legacyCovered.length > 0) {
    const widened = await prisma.agencyBranch.updateMany({
      where: { id: { in: legacyCovered.map((c) => c.branchId) }, deliveryRadiusKm: { lt: 10 } },
      data: { deliveryRadiusKm: 10 },
    });
    if (widened.count > 0) {
      console.log(`📏 وُسّع نطاق ${widened.count} فرع إلى 10كم (انتقال من التغطية بالمناطق)`);
    }
  }
  // سائقون أُضيفوا بنسخة كانت تتركهم غير معتمدين — لا واجهة اعتماد،
  // فكانوا محجوبين عن التوزيع والتعيين اليدوي نهائياً
  const fixed = await prisma.driverProfile.updateMany({
    where: { isVerified: false },
    data: { isVerified: true },
  });
  if (fixed.count > 0) console.log(`🛵 اعتُمد ${fixed.count} سائق كانوا محجوبين`);

  // مهلة ردّ السائق: عشرون ثانية لا تكفي من يصله إشعار وهو يقود — يفتح
  // التطبيق فيجد العرض قد راح. نرفعها مرة واحدة، وبشرط أنها ما زالت على
  // القيمة القديمة: من غيّرها من اللوحة عمداً لا يُنقض قراره.
  const bumped = await prisma.dispatchSettings.updateMany({
    where: { id: 1, offerTimeoutSeconds: 20 },
    data: { offerTimeoutSeconds: 45 },
  });
  if (bumped.count > 0) console.log('⏱️ رُفعت مهلة ردّ السائق من 20 إلى 45 ثانية');

  // نقل اللوحة المفردة القديمة إلى قائمة اللوحات. بلا هذا تختفي لوحة كل
  // سائق مسجَّل من الشاشة الجديدة (تقرأ القائمة) رغم بقائها في العمود.
  // idempotent: لا يلمس إلا من قائمته فارغة ولوحته المفردة موجودة.
  const movedPlates = await prisma.$executeRaw`
    UPDATE "DriverProfile"
    SET "vehiclePlates" = ARRAY["vehiclePlate"]
    WHERE "vehiclePlate" IS NOT NULL
      AND "vehiclePlate" <> ''
      AND cardinality("vehiclePlates") = 0
  `;
  if (movedPlates > 0) console.log(`🚚 نُقلت لوحة ${movedPlates} سائق إلى قائمة اللوحات`);

  // كل حساب قائم له رقم = رقمه موثَّق. قبل تحوّل الدخول إلى جوجل
  // (قرار 2026-08-30) لم يكن يُوجد حساب إلا برمز تحقق فعلي — واتساب أو
  // Firebase — فالرقم مُثبَت لا مُدَّعى، والعمود الجديد وحده هو ما ينقصه.
  //
  // بلا هذه التعبئة يصير كل زبون قائم «غير موثَّق» لحظة نشر العمود، فيُرفض
  // طلبه (assertPhoneVerified) بينما نسخة التطبيق التي بيده لا تعرف
  // PhoneVerificationRequired ولا تملك شاشة توثيق — رسالة خطأ بلا مخرج.
  //
  // idempotent: لا يلمس إلا من له رقم وتوثيقه فارغ، فتكراره عند كل إقلاع
  // لا يغيّر شيئاً بعد المرة الأولى.
  const backfilledPhones = await prisma.$executeRaw`
    UPDATE "User"
    SET "phoneVerifiedAt" = COALESCE("lastLoginAt", "createdAt")
    WHERE phone IS NOT NULL
      AND "phoneVerifiedAt" IS NULL
  `;
  if (backfilledPhones > 0) {
    console.log(`📱 وُثِّق رقم ${backfilledPhones} حساب قائم (تعبئة رجعية لمرة واحدة)`);
  }

  // كل حساب قائم اسمه مُقَرّ. قبل الدخول بجوجل كان الاسم يُكتب باليد عند
  // إنشاء الحساب — صاحبه هو من اختاره، فلا معنى لأن تعترضه شاشة «أكّد اسمك»
  // بعد شهور من الاستعمال. الشاشة لمن جاء اسمه من جوجل بلا أن يختاره.
  //
  // idempotent مثل ما حوله: لا يلمس إلا من إقراره فارغ.
  const backfilledNames = await prisma.$executeRaw`
    UPDATE "User"
    SET "nameConfirmedAt" = COALESCE("nameUpdatedAt", "createdAt")
    WHERE "nameConfirmedAt" IS NULL
  `;
  if (backfilledNames > 0) {
    console.log(`✍️ أُقرّ اسم ${backfilledNames} حساب قائم (تعبئة رجعية لمرة واحدة)`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
