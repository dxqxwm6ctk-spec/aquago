/**
 * لوحة AquaGo الإدارية — منطق العرض والحالة.
 *
 * نسخة ويب مباشرة (HTML/CSS/JS بلا إطار عمل) من تصميم Claude Design
 * (Aqua Go Admin.dc.html)، ضمن `backend/public/` مستقبلًا حين تُربط
 * بخادم AquaGo الفعلي (NestJS) — نفس نمط لوحات `/admin` و`/platform`
 * و`/agency` الموصوف في SKILL.md.
 *
 * ── دوران واحد بوضعين ──────────────────────────────────────────────
 * لوحة الوكالة هي نفسها لوحة الإدارة بنطاق أضيق: نفس الشاشات الأربع،
 * لكن الوكالة ترى سائقيها ومخزونها وطلباتها هي فقط، بينما المنصة ترى
 * كل المدن والوكالات. فبدل ملفّين متطابقين يتباعدان مع الوقت، اللوحة
 * واحدة و`MODE` يحدّد النطاق — يُقرأ من `?mode=agency` في الرابط،
 * وسيأتي لاحقًا من دور المستخدم بعد التحقّق في الخادم لا من الرابط
 * (إخفاء عنصر في الواجهة ليس أمنًا — SKILL.md §6).
 *
 * القيم أدناه (mock) مطابقة حرفيًا للحالة الافتراضية في التصميم الأصلي.
 * حين تُربط بالخادم، دوال `render*` تبقى كما هي؛ ما يتغيّر هو مصدر
 * `data` (يصير نتيجة `fetch` من `/api/v2/...` بدل ثابت محلي).
 */

const MODE = new URLSearchParams(location.search).get('mode') === 'agency'
  ? 'agency'
  : 'platform';

/** ما يميّز الوضعين: الهوية والنطاق وما يُعرض. */
const MODE_CONFIG = {
  platform: {
    tag: 'ADMIN',
    scope: 'عمّان الكبرى · ٨ سبتمبر ٢٠٢٦ · 8:18 ص',
    warehouse: 'مستودع صويلح',
    // المنصة ترى كل الطلبات وكل السائقين.
    driverFilter: () => true,
    orderFilter: () => true,
  },
  agency: {
    tag: 'AGENCY',
    scope: 'وكالة صويلح · ٨ سبتمبر ٢٠٢٦ · 8:18 ص',
    warehouse: 'مستودع الوكالة — صويلح',
    // الوكالة ترى سائقيها ومناطق تغطيتها فقط. الفلترة هنا للعرض؛
    // الخادم يفلتر فعليًا حسب `agencyId` المستخرَج من التوكن.
    driverFilter: (d) => d.agency === 'صويلح',
    orderFilter: (o) => AGENCY_AREAS.includes(o.area),
  },
};

/** مناطق تغطية وكالة صويلح — تُستبدل بحقل `coverage` من الخادم. */
const AGENCY_AREAS = ['صويلح', 'خلدا', 'تلاع العلي'];

const cfg = MODE_CONFIG[MODE];

const state = {
  page: 'overview', // overview | orders | drivers | stock
  filter: 'all', // all | live | done | bad
};

const titles = {
  overview: 'نظرة عامة',
  orders: 'إدارة الطلبات',
  drivers: 'أسطول السائقين',
  stock: 'المخزون والقوارير',
};

/* ============================== البيانات ============================== */

const kpis = [
  { label: 'طلبات اليوم', value: '184', delta: '▲ 12% عن أمس', deltaClass: 'up' },
  { label: 'إيراد اليوم', value: '612.500', delta: '▲ 8% عن أمس', deltaClass: 'up' },
  { label: 'متوسط زمن التوصيل', value: '38', unit: 'دقيقة', delta: '▼ 3 دقائق تحسّن', deltaClass: 'warn' },
];

const activeKpi = { label: 'طلبات نشطة الآن', value: '7', pill: '2 قيد التحضير · 5 في الطريق' };

const weekBars = [
  { label: 'السبت', h: 44, fill: 'var(--ag-sky-200)' },
  { label: 'الأحد', h: 58, fill: 'var(--ag-sky-300)' },
  { label: 'الاثنين', h: 50, fill: 'var(--ag-sky-300)' },
  { label: 'الثلاثاء', h: 70, fill: 'var(--ag-sky)' },
  { label: 'الأربعاء', h: 62, fill: 'var(--ag-sky)' },
  { label: 'الخميس', h: 92, fill: 'linear-gradient(180deg,#06B6D4,#075985)', peak: true },
  { label: 'الجمعة', h: 34, fill: 'var(--ag-line)' },
];

const mapLegend = [
  { label: 'سائق متصل', color: 'var(--ag-aqua)' },
  { label: 'طلب في الطريق', color: 'var(--ag-deep)' },
  { label: 'تأخير محتمل', color: 'var(--ag-warn-strong)' },
];

const topAreas = [
  { name: 'خلدا', count: '46', width: 86 },
  { name: 'تلاع العلي', count: '38', width: 70 },
  { name: 'الرابية', count: '31', width: 58 },
  { name: 'صويلح', count: '24', width: 44 },
];

const productMix = [
  { name: 'قارورة 18.9 لتر', share: '62% من الطلبات', count: '114', swatch: 'linear-gradient(160deg,#F0FBFF,#7DD3FC 62%,#38BDF8)' },
  { name: 'عبوة 4×5 لتر', share: '23% من الطلبات', count: '42', swatch: 'linear-gradient(160deg,#E0F5FD,#38BDF8)' },
  { name: 'كرتونة 12×1.5 لتر', share: '15% من الطلبات', count: '28', swatch: 'linear-gradient(160deg,#E0F2FE,#0EA5E9)' },
];

const alerts = [
  { kind: 'warn', title: 'مخزون منخفض — قوارير 18.9 لتر', body: 'متبقّي 48 قارورة في مستودع صويلح' },
  { kind: 'critical', title: 'طلب متأخر — AQ-1027', body: 'تجاوز 55 دقيقة · منطقة صويلح' },
  { kind: 'info', title: 'طلب انضمام سائق جديد', body: '3 طلبات بانتظار المراجعة' },
];

/** ألوان شارات حالة الطلب — من `chip` في التصميم الأصلي. */
const chipClass = {
  live: 'badge-info',
  prep: 'badge-warn',
  done: 'badge-ok',
  bad: 'badge-danger',
};

const allOrders = [
  { id: 'AQ-1042', customer: 'الحسن', phone: '079 041 6635', area: 'خلدا', item: 'قارورة 18.9 لتر × 2', driver: 'محمد العتوم', status: 'في الطريق', kind: 'live', total: '5.250' },
  { id: 'AQ-1041', customer: 'سارة ناصر', phone: '077 552 1180', area: 'تلاع العلي', item: 'عبوة 4×5 لتر × 3', driver: 'رامي الخطيب', status: 'قيد التحضير', kind: 'prep', total: '5.500' },
  { id: 'AQ-1040', customer: 'خالد أبو زيد', phone: '078 330 4472', area: 'الرابية', item: 'كرتونة 12×1.5 لتر × 1', driver: 'محمد العتوم', status: 'في الطريق', kind: 'live', total: '2.450' },
  { id: 'AQ-1039', customer: 'ليان سمير', phone: '079 118 9004', area: 'تلاع العلي', item: 'قارورة 18.9 لتر × 1', driver: 'رامي الخطيب', status: 'تم التسليم', kind: 'done', total: '2.750' },
  { id: 'AQ-1036', customer: 'عبدالله حمد', phone: '077 904 2213', area: 'الرابية', item: 'عبوة 4×5 لتر × 2', driver: 'رامي الخطيب', status: 'تم التسليم', kind: 'done', total: '3.750' },
  { id: 'AQ-1027', customer: 'دانا فريحات', phone: '078 664 7719', area: 'صويلح', item: 'قارورة 18.9 لتر × 3', driver: 'غير معيّن', status: 'ملغي', kind: 'bad', total: '0.000' },
];

/**
 * فلاتر شريط الطلبات. ملاحظة من التصميم الأصلي تُنقل كما هي: "نشطة"
 * تشمل `live` و`prep` معًا — الطلب قيد التحضير نشط أيضًا من منظور
 * العمليات، فلا يُخفى عن شاشة المتابعة.
 */
const filterPredicates = {
  all: () => true,
  live: (r) => r.kind === 'live' || r.kind === 'prep',
  done: (r) => r.kind === 'done',
  bad: (r) => r.kind === 'bad',
};

/**
 * مؤشّرات الأسطول تُحسب من السائقين ضمن النطاق لا من رقم ثابت — وإلا
 * رأت الوكالة نقد المنصة كلها (238.750) بينما سائقاها يحملان 110.500،
 * وهو رقم تسويةٍ تُحاسَب عليه فلا يجوز أن يكون خطأً.
 */
function computeDriverKpis(scoped) {
  const online = scoped.filter((d) => d.status !== 'غير متصل');
  const cash = scoped.reduce((sum, d) => sum + parseFloat(d.cash), 0);
  const rating = scoped.length
    ? scoped.reduce((sum, d) => sum + parseFloat(d.rating), 0) / scoped.length
    : 0;
  // المركبات تُعدّ باللوحات الفريدة لا بعدد السائقين المتصلين: وردية
  // مسائية قد يتسلّم فيها سائقٌ مركبةَ زميله، فالعدّادان يفترقان.
  const vehicles = new Set(online.map((d) => d.plate)).size;
  return [
    { label: 'سائقون متصلون', value: String(online.length) },
    { label: 'مركبات في الخدمة', value: String(vehicles) },
    { label: 'نقد لدى السائقين', value: cash.toFixed(3), amber: true },
    { label: 'متوسط التقييم', value: rating.toFixed(1) },
  ];
}

const drivers = [
  {
    name: 'محمد العتوم', plate: '43-2718', initial: 'م', agency: 'صويلح',
    avatar: 'linear-gradient(140deg,#38BDF8,#075985)', avatarInk: '#fff',
    status: 'في الطريق', statusClass: 'badge-info',
    orders: '11', cash: '62.000', rating: '4.9', bar: 78, barFlat: null,
  },
  {
    name: 'رامي الخطيب', plate: '39-1104', initial: 'ر', agency: 'صويلح',
    avatar: 'linear-gradient(140deg,#7DD3FC,#0E7490)', avatarInk: '#fff',
    status: 'متاح', statusClass: 'badge-ok',
    orders: '9', cash: '48.500', rating: '4.8', bar: 60, barFlat: null,
  },
  {
    name: 'عمر الزعبي', plate: '27-8890', initial: 'ع', agency: 'صويلح',
    avatar: 'var(--ag-bg)', avatarInk: 'var(--ag-ink-3)',
    status: 'غير متصل', statusClass: 'badge-muted',
    orders: '0', cash: '0.000', rating: '4.7', bar: 6, barFlat: 'var(--ag-line-2)',
  },
  // سائقو وكالات أخرى — تظهر للمنصة وحدها. وجودهم هو ما يجعل الفرق
  // بين النطاقين مرئيًا (6 متصلين للمنصة مقابل 2 للوكالة) ويطابق
  // أرقام التصميم الأصلي: 6 متصلين، 4 مركبات، نقد 238.750.
  {
    name: 'أحمد الشوابكة', plate: '51-3390', initial: 'أ', agency: 'الرابية',
    avatar: 'linear-gradient(140deg,#38BDF8,#0E7490)', avatarInk: '#fff',
    status: 'في الطريق', statusClass: 'badge-info',
    orders: '8', cash: '44.250', rating: '4.7', bar: 55, barFlat: null,
  },
  {
    name: 'ليث درويش', plate: '62-4471', initial: 'ل', agency: 'تلاع العلي',
    avatar: 'linear-gradient(140deg,#7DD3FC,#075985)', avatarInk: '#fff',
    status: 'متاح', statusClass: 'badge-ok',
    orders: '7', cash: '39.000', rating: '4.9', bar: 47, barFlat: null,
  },
  // سامر وزيد على لوحتَي أحمد وليث: وردية ثانية على المركبة نفسها —
  // ولهذا "مركبات في الخدمة" (4) أقلّ من "سائقون متصلون" (6).
  {
    name: 'سامر القضاة', plate: '51-3390', initial: 'س', agency: 'الرابية',
    avatar: 'linear-gradient(140deg,#38BDF8,#06B6D4)', avatarInk: '#fff',
    status: 'في الطريق', statusClass: 'badge-info',
    orders: '6', cash: '30.000', rating: '4.6', bar: 40, barFlat: null,
  },
  {
    name: 'زيد المومني', plate: '62-4471', initial: 'ز', agency: 'تلاع العلي',
    avatar: 'linear-gradient(140deg,#7DD3FC,#0E7490)', avatarInk: '#fff',
    status: 'متاح', statusClass: 'badge-ok',
    orders: '5', cash: '15.000', rating: '4.8', bar: 33, barFlat: null,
  },
];

const stockRows = [
  { name: 'قارورة 18.9 لتر', value: '48', width: 22, low: true },
  { name: 'عبوة 4×5 لتر', value: '210', width: 74, low: false },
  { name: 'كرتونة 12×1.5 لتر', value: '164', width: 58, low: false },
];

const bottleCycle = [
  { label: 'مع العملاء', value: '1,340' },
  { label: 'فارغة مسترجعة', value: '412' },
  { label: 'قيد التعقيم', value: '96' },
  { label: 'تالفة هذا الشهر', value: '18', bad: true },
];

/* ============================== أدوات ============================== */

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};

const card = (title, children, cls = 'card') =>
  el('div', { class: cls }, [title ? el('div', { class: 'card-title' }, title) : null, ...[].concat(children)]);

/* ============================== الشاشات ============================== */

function renderOverview() {
  const wrap = el('div', { class: 'screen' });

  // بطاقات المؤشّرات
  const kpiCards = kpis.map((k) =>
    el('div', { class: 'kpi-card' }, [
      el('div', { class: 'kpi-label' }, k.label),
      el('div', { class: 'kpi-value' }, [
        k.value,
        k.unit ? el('span', { class: 'unit' }, k.unit) : null,
      ]),
      el('div', { class: `kpi-delta ${k.deltaClass}` }, k.delta),
    ])
  );
  kpiCards.push(
    el('div', { class: 'kpi-card accent' }, [
      el('div', { class: 'kpi-label' }, activeKpi.label),
      el('div', { class: 'kpi-value' }, activeKpi.value),
      el('div', { class: 'kpi-pill' }, activeKpi.pill),
    ])
  );
  wrap.appendChild(el('div', { class: 'kpi-grid' }, kpiCards));

  // الإيراد الأسبوعي + خريطة الأسطول
  const revenueCard = el('div', { class: 'card' }, [
    el('div', { class: 'panel-head' }, [
      el('div', { class: 'card-title' }, 'الإيراد خلال الأسبوع'),
      el('div', { class: 'range-toggle' }, [
        el('button', { class: 'range-pill active', type: 'button' }, 'أسبوع'),
        el('button', { class: 'range-pill', type: 'button' }, 'شهر'),
      ]),
    ]),
    el('div', { class: 'bars' }, weekBars.map((b) =>
      el('div', { class: 'bar-col' }, [
        el('div', { class: 'bar-fill', style: `height:${b.h}%;background:${b.fill}` }),
        el('div', { class: `bar-label${b.peak ? ' peak' : ''}` }, b.label),
      ])
    )),
  ]);

  const mapCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'الطلبات على الخريطة'),
    el('div', { class: 'map-box' }, [el('div', { class: 'map-caption' }, 'live fleet map')]),
    el('div', { class: 'legend' }, mapLegend.map((l) =>
      el('div', { class: 'legend-item' }, [
        el('span', { class: 'legend-dot', style: `background:${l.color}` }),
        l.label,
      ])
    )),
  ]);

  wrap.appendChild(el('div', { class: 'grid-330' }, [revenueCard, mapCard]));

  // المناطق + المنتجات + التنبيهات
  const areasCard = card('أعلى المناطق طلبًا', topAreas.map((a) =>
    el('div', { class: 'area-row' }, [
      el('div', { class: 'area-head' }, [
        el('div', {}, a.name),
        el('div', { class: 'count' }, a.count),
      ]),
      el('div', { class: 'progress-track' }, [
        el('div', { class: 'progress-fill', style: `width:${a.width}%` }),
      ]),
    ])
  ));

  const productsCard = card('توزيع المنتجات', productMix.map((p) =>
    el('div', { class: 'product-row' }, [
      el('div', { class: 'product-swatch', style: `background:${p.swatch}` }),
      el('div', { class: 'product-main' }, [el('b', {}, p.name), el('small', {}, p.share)]),
      el('div', { class: 'product-count' }, p.count),
    ])
  ));

  const alertsCard = card('تنبيهات تشغيلية', alerts.map((a) =>
    el('div', { class: `alert alert-${a.kind}` }, [el('b', {}, a.title), el('span', {}, a.body)])
  ));

  wrap.appendChild(el('div', { class: 'grid-300' }, [areasCard, productsCard, alertsCard]));
  return wrap;
}

function renderOrders() {
  const wrap = el('div', { class: 'screen' });

  const scoped = allOrders.filter(cfg.orderFilter);
  const rows = scoped.filter(filterPredicates[state.filter]);

  // شريط الفلاتر — العدّ محسوب من البيانات الفعلية لا نصًّا ثابتًا
  // (التصميم الأصلي كان يكتب 184/7/172/5 بينما بياناته 6 صفوف).
  const counts = {
    all: scoped.length,
    live: scoped.filter(filterPredicates.live).length,
    done: scoped.filter(filterPredicates.done).length,
    bad: scoped.filter(filterPredicates.bad).length,
  };
  const filterDefs = [
    ['all', 'الكل'],
    ['live', 'نشطة'],
    ['done', 'مكتملة'],
    ['bad', 'ملغية'],
  ];

  wrap.appendChild(
    el('div', { class: 'filter-row' }, filterDefs.map(([key, label]) =>
      el('button', {
        class: `filter-pill${state.filter === key ? ' active' : ''}`,
        type: 'button',
        onclick: () => { state.filter = key; renderCurrentPage(); },
      }, `${label} · ${counts[key]}`)
    ))
  );

  const head = el('div', { class: 'table-head orders-head' }, [
    el('div', {}, 'رقم الطلب'),
    el('div', {}, 'العميل'),
    el('div', {}, 'المنطقة والمنتج'),
    el('div', {}, 'السائق'),
    el('div', {}, 'الحالة'),
    el('div', {}, 'المبلغ'),
  ]);

  const body = rows.map((r) =>
    el('div', { class: 'table-row orders-row' }, [
      el('div', { class: 'mono', style: 'font-size:13.5px;font-weight:600' }, r.id),
      el('div', { class: 'cell-stack' }, [
        el('b', {}, r.customer),
        el('small', { class: 'mono ltr-num' }, r.phone),
      ]),
      el('div', { class: 'cell-stack' }, [
        el('div', { style: 'font-size:13.5px' }, r.area),
        el('small', {}, r.item),
      ]),
      el('div', { style: 'font-size:13.5px' }, r.driver),
      el('div', {}, [el('span', { class: `badge ${chipClass[r.kind]}` }, r.status)]),
      el('div', { class: 'mono', style: 'font-size:14px;font-weight:600' }, r.total),
    ])
  );

  wrap.appendChild(el('div', { class: 'table-card' }, [head, ...body]));

  wrap.appendChild(
    el('div', { class: 'table-foot' }, [
      el('div', { class: 'foot-note' }, `عرض ${rows.length} من ${scoped.length} طلبًا`),
      el('div', { class: 'pager' }, [
        el('button', { class: 'pager-box', type: 'button' }, '›'),
        el('button', { class: 'pager-box active', type: 'button' }, '1'),
        el('button', { class: 'pager-box', type: 'button' }, '2'),
        el('button', { class: 'pager-box', type: 'button' }, '‹'),
      ]),
    ])
  );

  return wrap;
}

function renderDrivers() {
  const wrap = el('div', { class: 'screen' });
  const scoped = drivers.filter(cfg.driverFilter);

  wrap.appendChild(
    el('div', { class: 'kpi-grid' }, computeDriverKpis(scoped).map((k) =>
      el('div', { class: 'kpi-card' }, [
        el('div', { class: 'kpi-label' }, k.label),
        el('div', {
          class: 'kpi-value',
          style: k.amber ? 'color:var(--ag-warn-strong);font-size:30px' : 'font-size:30px',
        }, k.value),
      ])
    ))
  );

  wrap.appendChild(
    el('div', { class: 'grid-260' }, scoped.map((d) =>
      el('div', { class: 'driver-card' }, [
        el('div', { class: 'driver-head' }, [
          el('div', {
            class: 'driver-avatar',
            style: `background:${d.avatar};color:${d.avatarInk}`,
          }, d.initial),
          el('div', { class: 'driver-id' }, [
            el('b', {}, d.name),
            el('small', {}, ['بيك أب ', el('span', { class: 'ltr-num' }, d.plate)]),
          ]),
          el('span', { class: `badge ${d.statusClass}` }, d.status),
        ]),
        el('div', { class: 'driver-stats' }, [
          el('div', {}, [' طلبات اليوم: ', el('span', { class: 'mono' }, d.orders)]),
          el('div', {}, ['تحصيل: ', el('span', { class: 'mono' }, d.cash)]),
          el('div', {}, [el('span', { class: 'mono' }, d.rating), ' ★']),
        ]),
        el('div', { class: 'progress-track' }, [
          el('div', {
            class: 'progress-fill',
            style: `width:${d.bar}%${d.barFlat ? `;background:${d.barFlat}` : ''}`,
          }),
        ]),
      ])
    ))
  );

  return wrap;
}

function renderStock() {
  const wrap = el('div', { class: 'screen' });

  const warehouseCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, cfg.warehouse),
    ...stockRows.map((s) =>
      el('div', { class: 'stock-row' }, [
        el('div', { class: 'stock-head' }, [
          el('div', {}, s.name),
          el('div', { class: `value${s.low ? ' low' : ''}` }, s.value),
        ]),
        el('div', { class: 'stock-track' }, [
          el('div', { class: `stock-fill${s.low ? ' low' : ''}`, style: `width:${s.width}%` }),
        ]),
      ])
    ),
    el('button', { class: 'btn-refill', type: 'button' }, 'طلب تعبئة من المصنع'),
  ]);

  const cycleCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'دورة القوارير'),
    el('div', { class: 'cycle-grid' }, bottleCycle.map((c) =>
      el('div', { class: 'cycle-tile' }, [
        el('div', { class: 'label' }, c.label),
        el('div', { class: `value${c.bad ? ' bad' : ''}` }, c.value),
      ])
    )),
    el('div', { class: 'cycle-note' }, 'نسبة الاسترجاع 82% — الهدف التشغيلي 90% قبل نهاية الربع.'),
  ]);

  wrap.appendChild(el('div', { class: 'grid-300' }, [warehouseCard, cycleCard]));
  return wrap;
}

const screenRenderers = {
  overview: renderOverview,
  orders: renderOrders,
  drivers: renderDrivers,
  stock: renderStock,
};

/* ============================== الربط العام ============================== */

function renderCurrentPage() {
  document.getElementById('pageTitle').textContent = titles[state.page];

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === state.page);
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(screenRenderers[state.page]());
}

/** يضبط هوية اللوحة (الوسم والنطاق) حسب الوضع قبل أول رسم. */
function applyMode() {
  document.querySelector('.brand-tag').textContent = cfg.tag;
  document.querySelector('.page-note').textContent = cfg.scope;
  document.title = MODE === 'agency'
    ? 'AquaGo Agency · لوحة الوكالة'
    : 'AquaGo Admin · لوحة المنصة';
}

document.getElementById('nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  state.page = item.dataset.page;
  renderCurrentPage();
});

applyMode();
renderCurrentPage();
