/**
 * لوحة AquaGo Control (المالك) — منطق العرض والحالة.
 *
 * هذه نسخة ويب مباشرة (HTML/CSS/JS بلا إطار عمل) من تصميم Claude Design
 * (Aqua Go Control.dc.html)، ضمن `backend/public/` مستقبلًا حين يُربط
 * هذا الملف بخادم GasGO/AquaGo الفعلي (NestJS) — نفس نمط لوحات
 * `/admin` و`/platform` و`/agency` الموصوف في SKILL.md.
 *
 * القيم أدناه (mock) مطابقة حرفيًا للحالة الافتراضية في التصميم الأصلي.
 * حين يُربط بالخادم، كل دالة `render*` هنا تبقى كما هي؛ ما يتغيّر هو
 * مصدر `state.*` (يصبح نتيجة `fetch` من `/api/v2/...` بدل ثابت محلي)،
 * ودوال `action.*` تصبح تُرسل الطلب فعليًا قبل تحديث الحالة محليًا.
 */

const state = {
  page: 'exec',
  city: 'all',
  price: 2.5, // سعر قارورة 18.9 لتر (د.أ)
  fee: 0.25, // رسوم التوصيل (د.أ)
  freeze: false,
  perm: {
    // ترتيب مطابق لـ permLabels أدناه. المالك دائمًا مفعَّل، لا يُبدَّل.
    ops: [true, true, false, true, false, false],
    fin: [true, false, true, false, true, false],
  },
  flags: [true, true, false, true, false],
};

const OWNER_NAME = 'الحسن الزعبي';

const titles = {
  exec: ['اللوحة التنفيذية', 'مؤشرات المشروع الكاملة · تحديث لحظي'],
  team: ['المديرون والصلاحيات', 'من يرى ماذا ومن يستطيع التعديل'],
  money: ['المالية والتسعير', 'التحكم بالأسعار والتسوية النقدية'],
  control: ['التحكم بالمنصة', 'الميزات، المدن، ووضع الطوارئ'],
  audit: ['سجل التغييرات', 'كل إجراء إداري موثّق باسم المنفّذ'],
};

const cityData = {
  all: { gmv: '17,130', delta: '▲ 18% عن الشهر الماضي', profit: '4,260', margin: '24.9%', users: '3,412' },
  amman: { gmv: '12,840', delta: '▲ 14% عن الشهر الماضي', profit: '3,540', margin: '27.6%', users: '2,480' },
  irbid: { gmv: '3,510', delta: '▲ 31% عن الشهر الماضي', profit: '760', margin: '21.6%', users: '742' },
  zarqa: { gmv: '780', delta: '▲ 9% عن الشهر الماضي', profit: '−40', margin: '−5.1%', users: '190' },
};

const monthlyGrowth = [
  { label: 'أبريل', h: 32, color: '#BAE6FD' },
  { label: 'مايو', h: 44, color: '#7DD3FC' },
  { label: 'يونيو', h: 52, color: '#7DD3FC' },
  { label: 'يوليو', h: 66, color: '#38BDF8' },
  { label: 'أغسطس', h: 80, color: '#06B6D4' },
  { label: 'سبتمبر', h: 96, gradient: true },
];

const cityRows = [
  { name: 'عمّان', meta: '4,120 طلب · 6 سائقين', value: '12,840', tag: 'رابح', good: true },
  { name: 'إربد', meta: '1,260 طلب · 2 سائقين', value: '3,510', tag: 'رابح', good: true },
  { name: 'الزرقاء', meta: '310 طلب · سائق واحد', value: '780', tag: 'تجريبي', good: false },
];

const decisions = [
  'رفع رسوم التوصيل في الزرقاء',
  'توظيف 3 سائقين لإربد',
  'عقد مصنع تعبئة ثانٍ',
];

const roleStyle = {
  owner: { bg: 'var(--role-owner-bg)', ink: 'var(--role-owner-ink)' },
  ops: { bg: 'var(--role-ops-bg)', ink: 'var(--role-ops-ink)' },
  fin: { bg: 'var(--role-fin-bg)', ink: 'var(--role-fin-ink)' },
};

const admins = [
  { initial: 'ح', name: 'الحسن الزعبي', email: 'hassan@aquago.jo', role: 'مالك المشروع', kind: 'owner', scope: 'كل المدن', seen: 'الآن', active: true, avatarBg: 'linear-gradient(140deg,#38BDF8,#075985)' },
  { initial: 'ن', name: 'نور القاضي', email: 'nour@aquago.jo', role: 'مدير عمليات', kind: 'ops', scope: 'عمّان', seen: '8:02 ص', active: true, avatarBg: 'linear-gradient(140deg,#7DD3FC,#0E7490)' },
  { initial: 'ي', name: 'يزن المصري', email: 'yazan@aquago.jo', role: 'مدير عمليات', kind: 'ops', scope: 'إربد + الزرقاء', seen: 'أمس 9:40 م', active: true, avatarBg: 'linear-gradient(140deg,#7DD3FC,#0E7490)' },
  { initial: 'ل', name: 'لينا حدّاد', email: 'lina@aquago.jo', role: 'مدير مالي', kind: 'fin', scope: 'كل المدن', seen: '7:55 ص', active: true, avatarBg: 'linear-gradient(140deg,#38BDF8,#0369A1)' },
  { initial: 'ط', name: 'طارق سليم', email: 'tareq@aquago.jo', role: 'مدير عمليات', kind: 'ops', scope: 'الزرقاء', seen: 'قبل 6 أيام', active: false, avatarBg: '#94A3B8' },
];

const permLabels = [
  'عرض الطلبات والأسطول',
  'تعديل الأسعار والرسوم',
  'الاطلاع على المالية',
  'إدارة السائقين',
  'تصدير التقارير',
  'إدارة المديرين والصلاحيات',
];

const flagData = [
  { label: 'الاشتراك الأسبوعي للمياه', note: 'تجديد تلقائي مع خصم 10%' },
  { label: 'الدفع الإلكتروني', note: 'بطاقات + محفظة إلكترونية' },
  { label: 'التوصيل المجدول مسبقًا', note: 'حتى 7 أيام مقدمًا' },
  { label: 'أكواد الخصم والإحالة', note: 'يديرها فريق التسويق' },
  { label: 'التوصيل الليلي', note: 'من 10 م حتى 6 ص' },
];

const cityOps = [
  { name: 'عمّان الكبرى', label: 'تعمل', bg: 'var(--success-bg)', ink: 'var(--success-ink)' },
  { name: 'إربد', label: 'تعمل', bg: 'var(--success-bg)', ink: 'var(--success-ink)' },
  { name: 'الزرقاء', label: 'تجريبي', bg: 'var(--warn-bg)', ink: 'var(--warn-ink)' },
  { name: 'العقبة', label: 'قريبًا', bg: 'var(--bg-subtle)', ink: 'var(--ink-subtle)' },
];

const settlements = [
  { name: 'محمد العتوم', meta: 'وردية اليوم · 11 طلبًا', amount: '62.000', settled: false },
  { name: 'رامي الخطيب', meta: 'وردية اليوم · 9 طلبات', amount: '48.500', settled: false },
  { name: 'مستودع إربد', meta: 'أمس · 26 طلبًا', amount: 'مورّد', settled: true },
];

// سجل التغييرات — append-only: إضافة فقط في المقدّمة، لا تعديل ولا حذف
// (يقابل نمط دفتر القيود الموصوف في SKILL.md للمال؛ هنا محاكاة محلية).
const logs = [
  { time: '8:12 ص', action: 'تعديل رسوم التوصيل من 0.200 إلى 0.250 د.أ', who: OWNER_NAME, scope: 'كل المدن' },
  { time: '7:58 ص', action: 'تشغيل ميزة الاشتراك الأسبوعي', who: OWNER_NAME, scope: 'عمّان' },
  { time: 'أمس 9:34 م', action: 'إيقاف حساب المدير طارق سليم', who: OWNER_NAME, scope: 'الزرقاء' },
  { time: 'أمس 6:20 م', action: 'تأكيد توريد نقد 214.500 د.أ', who: 'لينا حدّاد', scope: 'عمّان' },
  { time: 'أمس 2:05 م', action: 'إضافة مستودع إربد الثاني', who: 'يزن المصري', scope: 'إربد' },
  { time: '٦ سبتمبر', action: 'رفع سعر قارورة 18.9 لتر إلى 2.500 د.أ', who: OWNER_NAME, scope: 'كل المدن' },
];

function addLog(action, scope = 'كل المدن') {
  logs.unshift({ time: 'الآن', action, who: OWNER_NAME, scope });
}

function fmt3(n) {
  return n.toFixed(3);
}

function thousands(n) {
  return Math.abs(Math.round(n)).toLocaleString('en-US');
}

function priceImpactLabel() {
  const monthlyOrders = 6850;
  const diff = (state.price - 2.5) * monthlyOrders + (state.fee - 0.25) * monthlyOrders;
  const sign = diff >= 0 ? '+' : '−';
  return `${sign}${thousands(diff)} د.أ تقديريًا`;
}

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

/* ============================== الشاشات ============================== */

function renderExecutive() {
  const c = cityData[state.city];
  const wrap = el('div', { class: 'screen' });

  // بطاقات المؤشرات الأربعة
  const stats = el('div', { class: 'grid-auto' }, [
    el('div', { class: 'stat-hero' }, [
      el('div', { class: 'stat-label' }, 'إجمالي المبيعات — الشهر'),
      el('div', { class: 'stat-value' }, c.gmv),
      el('div', { class: 'stat-pill' }, c.delta),
    ]),
    el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label' }, 'صافي الربح'),
      el('div', { class: 'stat-value' }, c.profit),
      el('div', { class: 'stat-sub good' }, ['هامش ', c.margin]),
    ]),
    el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label' }, 'عملاء نشطون'),
      el('div', { class: 'stat-value' }, c.users),
      el('div', { class: 'stat-sub good' }, 'تكرار الطلب 2.4×/شهر'),
    ]),
    el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label' }, 'تكلفة الطلب الواحد'),
      el('div', { class: 'stat-value' }, '0.940'),
      el('div', { class: 'stat-sub warn' }, 'الهدف 0.800 د.أ'),
    ]),
  ]);

  // النمو + أداء المدن
  const growthCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'النمو خلال 6 أشهر'),
    el('div', { class: 'bars' }, monthlyGrowth.map((m) =>
      el('div', { class: 'bar-col' }, [
        el('div', {
          class: 'bar-fill',
          style: `height:${m.h}%;background:${m.gradient ? 'linear-gradient(180deg,#06B6D4,#075985)' : m.color}`,
        }),
        el('div', { class: m.gradient ? 'bar-label current' : 'bar-label' }, m.label),
      ])
    )),
  ]);

  const citiesCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'أداء المدن'),
    el('div', { style: 'display:flex;flex-direction:column;gap:14px' }, cityRows.map((r) =>
      el('div', { class: 'city-row' }, [
        el('div', { class: 'city-row-name' }, [
          el('b', {}, r.name),
          el('small', {}, r.meta),
        ]),
        el('div', { class: 'city-row-value' }, r.value),
        el('div', {
          class: 'badge',
          style: r.good
            ? 'background:var(--success-bg);color:var(--success-ink)'
            : 'background:var(--warn-bg);color:var(--warn-ink)',
        }, r.tag),
      ])
    )),
  ]);

  const growthRow = el('div', { class: 'grid-auto-wide' }, [growthCard, citiesCard]);

  // قرارات + جودة الخدمة + تدفّق نقدي
  const decisionsCard = el('div', { class: 'card card-dark' }, [
    el('div', { class: 'card-title-sm' }, 'قرارات بانتظارك'),
    el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, decisions.map((d) =>
      el('div', { class: 'decision-tile' }, [
        el('span', {}, d),
        el('span', { class: 'decision-badge' }, 'مراجعة'),
      ])
    )),
  ]);

  const qualityCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title-sm' }, 'جودة الخدمة'),
    progressRow('التسليم في الوقت', '94%', 94),
    progressRow('رضا العملاء', '4.8 / 5', 96),
    progressRow('نسبة الإلغاء', '2.7%', 14, true),
  ]);

  const cashCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title-sm' }, 'التدفّق النقدي'),
    el('div', { class: 'cash-row' }, [el('div', {}, 'محصّل نقدًا'), el('div', { class: 'value' }, '14,260')]),
    el('div', { class: 'cash-row' }, [el('div', {}, 'لدى السائقين'), el('div', { class: 'value', style: 'color:var(--amber-ink)' }, '238.750')]),
    el('div', { class: 'cash-row' }, [el('div', {}, 'مصاريف تشغيل'), el('div', { class: 'value' }, '−9,410')]),
    el('div', { class: 'cash-total' }, [el('b', {}, 'الرصيد البنكي'), el('div', { class: 'value' }, '31,880')]),
  ]);

  const bottomRow = el('div', { class: 'grid-auto-med' }, [decisionsCard, qualityCard, cashCard]);

  wrap.append(stats, growthRow, bottomRow);
  return wrap;
}

function progressRow(label, value, pct, amber = false) {
  return el('div', { class: 'progress-row' }, [
    el('div', { class: 'progress-head' }, [el('div', {}, label), el('div', { class: 'value mono' }, value)]),
    el('div', { class: 'progress-track' }, [
      el('div', { class: `progress-fill${amber ? ' amber' : ''}`, style: `width:${pct}%` }),
    ]),
  ]);
}

function renderTeam() {
  const wrap = el('div', { class: 'screen' });

  const actions = el('div', { class: 'team-actions' }, [
    el('div', { class: 'invite-btn' }, 'دعوة مدير جديد'),
    el('div', { class: 'team-count' }, `${admins.length} حسابات إدارية · 3 أدوار معرّفة`),
  ]);

  const tableHead = el('div', { class: 'table-head admins-head' }, [
    el('div', {}, 'المدير'), el('div', {}, 'الدور'), el('div', {}, 'النطاق'), el('div', {}, 'آخر دخول'), el('div', {}, 'الحالة'),
  ]);

  const tableRows = admins.map((a) => {
    const style = roleStyle[a.kind];
    return el('div', { class: 'table-row admins-row' }, [
      el('div', { class: 'admin-identity' }, [
        el('div', { class: 'avatar', style: `background:${a.avatarBg}` }, a.initial),
        el('div', { class: 'admin-name-block' }, [el('b', {}, a.name), el('small', {}, a.email)]),
      ]),
      el('div', {}, [el('span', { class: 'badge', style: `background:${style.bg};color:${style.ink}` }, a.role)]),
      el('div', { style: 'font-size:13px;color:var(--ink-subtle)' }, a.scope),
      el('div', { class: 'mono', style: 'font-size:12.5px;color:var(--ink-muted)' }, a.seen),
      el('div', {
        style: `font-size:12.5px;font-weight:600;color:${a.active ? 'var(--success-ink)' : 'var(--danger-bg)'}`,
      }, a.active ? 'نشط' : 'موقوف'),
    ]);
  });

  const table = el('div', { class: 'table-card' }, [tableHead, ...tableRows]);

  const permHead = el('div', { class: 'perm-matrix-head' }, [
    el('div', { class: 'card-title' }, 'مصفوفة الصلاحيات'),
    el('div', { class: 'audit-hint' }, 'اضغط الخلية للتبديل — التغيير يُسجّل في سجل التغييرات'),
  ]);

  const permColsHead = el('div', { class: 'perm-cols-head' }, [
    el('div', {}, 'الصلاحية'),
    el('div', { class: 'center' }, 'مالك'),
    el('div', { class: 'center' }, 'مدير عمليات'),
    el('div', { class: 'center' }, 'مدير مالي'),
  ]);

  const ON = 'var(--perm-on)';
  const OFF = 'var(--perm-off)';
  const permRows = permLabels.map((label, i) =>
    el('div', { class: 'perm-row' }, [
      el('div', { class: 'label' }, label),
      el('div', { class: 'perm-cell-wrap' }, [el('div', { class: 'perm-cell', style: `background:${ON}` })]),
      el('div', { class: 'perm-cell-wrap' }, [
        el('div', {
          class: 'perm-cell toggle',
          style: `background:${state.perm.ops[i] ? ON : OFF}`,
          onclick: () => {
            state.perm.ops[i] = !state.perm.ops[i];
            addLog(`${state.perm.ops[i] ? 'تفعيل' : 'إلغاء'} صلاحية "${label}" لمدير العمليات`);
            renderCurrentPage();
          },
        }),
      ]),
      el('div', { class: 'perm-cell-wrap' }, [
        el('div', {
          class: 'perm-cell toggle',
          style: `background:${state.perm.fin[i] ? ON : OFF}`,
          onclick: () => {
            state.perm.fin[i] = !state.perm.fin[i];
            addLog(`${state.perm.fin[i] ? 'تفعيل' : 'إلغاء'} صلاحية "${label}" للمدير المالي`);
            renderCurrentPage();
          },
        }),
      ]),
    ])
  );

  const permCard = el('div', { class: 'card perm-matrix-card' }, [
    permHead,
    el('div', { class: 'perm-matrix-scroll' }, [
      el('div', { class: 'perm-matrix' }, [permColsHead, ...permRows]),
    ]),
  ]);

  wrap.append(actions, table, permCard);
  return wrap;
}

function renderFinance() {
  const wrap = el('div', { class: 'screen' });

  const pricingCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'التحكم بالأسعار'),
    priceRow('قارورة 18.9 لتر', 'هامش 38%', fmt3(state.price), () => {
      state.price = Math.max(1.5, state.price - 0.25);
      addLog(`خفض سعر قارورة 18.9 لتر إلى ${fmt3(state.price)} د.أ`);
      renderCurrentPage();
    }, () => {
      state.price = Math.min(4, state.price + 0.25);
      addLog(`رفع سعر قارورة 18.9 لتر إلى ${fmt3(state.price)} د.أ`);
      renderCurrentPage();
    }),
    priceRow('رسوم التوصيل', 'تُطبّق على كل المدن', fmt3(state.fee), () => {
      state.fee = Math.max(0, state.fee - 0.05);
      addLog(`تعديل رسوم التوصيل إلى ${fmt3(state.fee)} د.أ`);
      renderCurrentPage();
    }, () => {
      state.fee = Math.min(1, state.fee + 0.05);
      addLog(`تعديل رسوم التوصيل إلى ${fmt3(state.fee)} د.أ`);
      renderCurrentPage();
    }),
    el('div', { class: 'impact-box' }, [
      'الأثر المتوقّع على إيراد الشهر: ',
      el('span', { class: 'mono' }, priceImpactLabel()),
    ]),
    el('div', { class: 'publish-btn' }, 'نشر الأسعار الجديدة'),
  ]);

  const settleCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'تسوية النقد والتوريدات'),
    ...settlements.map((s) =>
      el('div', { class: 'settle-row' }, [
        el('div', { class: 'settle-info' }, [el('b', {}, s.name), el('small', {}, s.meta)]),
        el('div', {
          class: 'settle-amount mono',
          style: `color:${s.settled ? 'var(--success-ink)' : 'var(--amber-ink)'}`,
        }, s.amount),
        s.settled
          ? el('span', { class: 'badge', style: 'background:var(--success-bg);color:var(--success-ink)' }, 'مغلق')
          : el('div', { class: 'settle-confirm' }, 'تأكيد التوريد'),
      ])
    ),
    el('div', { class: 'cash-total' }, [
      el('b', {}, 'مجموع النقد غير المورّد'),
      el('div', { class: 'value', style: 'font-size:20px;color:var(--amber-ink)' }, '110.500'),
    ]),
  ]);

  wrap.append(el('div', { class: 'grid-auto-300' }, [pricingCard, settleCard]));
  return wrap;
}

function priceRow(title, note, value, onDown, onUp) {
  return el('div', { class: 'price-row' }, [
    el('div', { class: 'price-row-info' }, [el('b', {}, title), el('small', {}, note)]),
    el('div', { class: 'price-stepper' }, [
      el('div', { class: 'step-btn minus', onclick: onDown }, '−'),
      el('div', { class: 'price-value mono' }, value),
      el('div', { class: 'step-btn plus', onclick: onUp }, '+'),
    ]),
  ]);
}

function renderControl() {
  const wrap = el('div', { class: 'screen' });

  const flagsCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'مفاتيح تشغيل الميزات'),
    ...flagData.map((f, i) =>
      el('div', { class: 'flag-row' }, [
        el('div', { class: 'flag-info' }, [el('b', {}, f.label), el('small', {}, f.note)]),
        el('div', {
          class: `toggle-track${state.flags[i] ? ' on' : ''}`,
          onclick: () => {
            state.flags[i] = !state.flags[i];
            addLog(`${state.flags[i] ? 'تشغيل' : 'إيقاف'} ميزة "${f.label}"`);
            renderCurrentPage();
          },
        }, [el('div', { class: 'toggle-knob' })]),
      ])
    ),
  ]);

  const citiesCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-title' }, 'تشغيل المدن'),
    ...cityOps.map((c) =>
      el('div', { class: 'city-op-row' }, [
        el('span', {}, c.name),
        el('div', { class: 'badge', style: `background:${c.bg};color:${c.ink}` }, c.label),
      ])
    ),
  ]);

  const emergencyCard = el('div', { class: 'card card-dark' }, [
    el('div', { class: 'card-title-sm' }, 'وضع الطوارئ'),
    el('div', { class: 'emergency-note' }, 'يوقف استقبال الطلبات الجديدة في كل المدن ويُظهر رسالة للعملاء. متاح للمالك فقط.'),
    el('div', {
      class: `freeze-btn${state.freeze ? ' frozen' : ''}`,
      onclick: () => {
        state.freeze = !state.freeze;
        addLog(state.freeze ? 'إيقاف استقبال الطلبات فورًا' : 'إعادة تشغيل الطلبات');
        renderCurrentPage();
      },
    }, state.freeze ? 'الطلبات موقوفة — إعادة التشغيل' : 'إيقاف الطلبات فورًا'),
  ]);

  const rightCol = el('div', { style: 'display:flex;flex-direction:column;gap:18px' }, [citiesCard, emergencyCard]);

  wrap.append(el('div', { class: 'grid-auto-300' }, [flagsCard, rightCol]));
  return wrap;
}

function renderAudit() {
  const wrap = el('div', { class: 'screen' });

  const head = el('div', { class: 'table-head audit-head' }, [
    el('div', {}, 'الوقت'), el('div', {}, 'الإجراء'), el('div', {}, 'المنفّذ'), el('div', {}, 'النطاق'),
  ]);

  const rows = logs.map((l) =>
    el('div', { class: 'table-row audit-row' }, [
      el('div', { class: 'mono', style: 'font-size:12.5px;color:var(--ink-muted)' }, l.time),
      el('div', { style: 'font-size:13.5px' }, l.action),
      el('div', { style: 'font-size:13px;color:var(--ink-subtle)' }, l.who),
      el('div', {}, [el('span', { class: 'badge', style: 'background:var(--bg-subtle);color:var(--ink-subtle)' }, l.scope)]),
    ])
  );

  const table = el('div', { class: 'table-card' }, [head, ...rows]);
  const note = el('div', { class: 'audit-hint' }, 'كل تغيير في الأسعار أو الصلاحيات أو المدن يُسجّل تلقائيًا ولا يمكن حذفه.');

  wrap.append(table, note);
  return wrap;
}

const screenRenderers = {
  exec: renderExecutive,
  team: renderTeam,
  money: renderFinance,
  control: renderControl,
  audit: renderAudit,
};

/* ============================== الربط العام ============================== */

function renderCurrentPage() {
  const [title, note] = titles[state.page];
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageNote').textContent = note;

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === state.page);
  });

  document.querySelectorAll('.city-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.city === state.city);
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(screenRenderers[state.page]());
}

document.getElementById('nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  state.page = item.dataset.page;
  renderCurrentPage();
});

document.getElementById('cityFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.city-chip');
  if (!chip) return;
  state.city = chip.dataset.city;
  renderCurrentPage();
});

renderCurrentPage();
