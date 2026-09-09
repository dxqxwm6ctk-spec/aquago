import type { InvoiceSettings } from '@prisma-v2/client';

/**
 * قالب الفاتورة — HTML يُطبع مباشرة من المتصفح (طباعة ← حفظ كـPDF).
 *
 * لماذا HTML لا PDF مولَّد؟ مكتبة PDF تضيف اعتماداً ثقيلاً وخطوطاً عربية
 * مضمَّنة يدوياً، ولا تعطي شيئاً لا تعطيه الطباعة من المتصفح. وRTL والخطوط
 * العربية تعمل هنا بلا حيلة.
 *
 * التصميم مطابق للوحة التصميم المعتمدة: قرمزي #A41442 وذهبي #E2A82F،
 * IBM Plex Sans Arabic، صفحة A4.
 */

const C = {
  primary: '#A41442',
  gold: '#E2A82F',
  ink: '#231A1D',
  body: '#5C5257',
  muted: '#6E6367',
  label: '#8A7C81',
  border: '#EADFE3',
  tint: '#FCFAFB',
  goldTint: '#FDF9F0',
  goldInk: '#8A5D06',
} as const;

export interface InvoiceLine {
  nameAr: string;
  descAr?: string | null;
  periodAr?: string | null;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface InvoiceTotalLine {
  label: string;
  amount: number;
  /** سطر الخصم يظهر بالسالب وبلون مختلف */
  negative?: boolean;
}

export interface InvoiceKeyValue {
  label: string;
  value: string;
  /** أرقام ومعرّفات تُقرأ يساراً حتى داخل صفحة عربية */
  ltr?: boolean;
}

export interface InvoiceDoc {
  /** شارة العنوان أعلى اليسار */
  titleAr: string;
  /** لون الشارة — الأسود للإيصالات والقرمزي للفواتير، كما في التصميم */
  titleDark?: boolean;
  subtitleAr?: string | null;
  /** رقم المستند الظاهر */
  number: string;
  /** بطاقات المعلومات (شبكة 2×2) */
  info: InvoiceKeyValue[];
  /** عنوان جدول البنود */
  tableCaptionAr?: string;
  lines?: InvoiceLine[];
  /** صفوف تفصيلية بدل جدول البنود (كإيصال الدفع) */
  details?: InvoiceKeyValue[];
  totals?: InvoiceTotalLine[];
  /** السطر الأخير المميّز */
  grandLabel?: string;
  grandAmount?: number;
  /** شارة حالة ملوّنة */
  status?: { label: string; tone: 'ok' | 'warn' | 'muted' } | null;
  noteAr?: string | null;
  /** ختم «معتمد» — يظهر فقط إن سمح الإعداد وطلبه المستند */
  stamp?: { label: string; subLabel: string } | null;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** الدينار بثلاث خانات كما في الأردن */
const jod = (n: number) => `${Number(n).toFixed(3)} د.أ`;

const dateAr = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleDateString('ar-JO', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    : '—';

const STATUS_TONE = {
  ok: { bg: '#EAF6EE', border: '#6FA982', fg: '#2F6B44', dot: '#3E8A57' },
  warn: { bg: '#FDF4E2', border: C.gold, fg: C.goldInk, dot: C.gold },
  muted: { bg: '#F4EFF1', border: '#C9B9BF', fg: '#6E6367', dot: '#9A8288' },
} as const;

/** ترويسة الهوية — كل سطر فيها محكوم بمفتاح إظهاره */
function header(s: InvoiceSettings, doc: InvoiceDoc): string {
  const idLine = [
    s.showLicenseNumber && s.licenseNumber
      ? `رقم الترخيص: ${esc(s.licenseNumber)}`
      : null,
    s.showTaxNumber && s.taxNumber ? `الرقم الضريبي: ${esc(s.taxNumber)}` : null,
  ].filter(Boolean).join(' · ');

  const contactLine = [
    s.showPhone && s.phone ? esc(s.phone) : null,
    s.showEmail && s.email ? esc(s.email) : null,
    s.showWebsite && s.website ? esc(s.website) : null,
  ].filter(Boolean).join(' · ');

  // شعار غائب أو مخفي: لا صندوق فارغ متقطّع على مستند رسمي
  const logo =
    s.showLogo && s.logoUrl
      ? `<img src="${esc(s.logoUrl)}" alt="" style="width:84px;height:84px;object-fit:contain;border-radius:10px;flex:none">`
      : '';

  const names = [
    s.showCompanyNameAr && s.companyNameAr
      ? `<div style="font-size:22px;font-weight:700;color:${C.primary};letter-spacing:-.2px">${esc(s.companyNameAr)}</div>`
      : '',
    s.showCompanyNameEn && s.companyNameEn
      ? `<div style="font-size:13px;font-weight:600;color:${C.muted};direction:ltr;text-align:right">${esc(s.companyNameEn)}</div>`
      : '',
  ].join('');

  return `
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:28px;border-bottom:3px solid ${C.primary};padding-bottom:22px">
    <div style="display:flex;gap:16px;align-items:center;min-width:0">
      ${logo}
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        ${names}
        <div style="font-size:11.5px;color:${C.muted};line-height:1.6">
          ${s.showAddress && s.addressAr ? `<div>${esc(s.addressAr)}</div>` : ''}
          ${idLine ? `<div>${idLine}</div>` : ''}
          ${contactLine ? `<div style="direction:ltr;text-align:right;unicode-bidi:isolate">${contactLine}</div>` : ''}
        </div>
      </div>
    </div>
    <div style="text-align:left;display:flex;flex-direction:column;gap:8px;align-items:flex-end;flex:none">
      <div style="background:${doc.titleDark ? C.ink : C.primary};color:#fff;padding:10px 20px;border-radius:6px;font-size:17px;font-weight:700;white-space:nowrap">${esc(doc.titleAr)}</div>
      ${doc.subtitleAr ? `<div style="font-size:12px;color:${C.muted}">${esc(doc.subtitleAr)}</div>` : ''}
      <div style="font-size:12px;color:${C.muted}">رقم المستند:
        <span style="direction:ltr;unicode-bidi:isolate;font-weight:600;color:${C.ink}">${esc(doc.number)}</span>
      </div>
      <div style="height:4px;width:120px;background:${C.gold};border-radius:2px"></div>
    </div>
  </div>`;
}

/** شبكة بطاقات المعلومات — عمودان، وحدود داخلية فقط */
function infoGrid(items: InvoiceKeyValue[]): string {
  if (!items.length) return '';
  return `
  <div style="display:grid;grid-template-columns:1fr 1fr;margin-top:26px;border:1px solid ${C.border};border-radius:10px;overflow:hidden">
    ${items.map((it, i) => {
      const leftBorder = i % 2 === 0 ? `border-left:1px solid ${C.border};` : '';
      const topBorder = i >= 2 ? `border-top:1px solid ${C.border};` : '';
      return `<div style="padding:16px 20px;${leftBorder}${topBorder}background:${C.tint}">
        <div style="font-size:11.5px;color:${C.label};font-weight:500">${esc(it.label)}</div>
        <div style="font-size:16px;font-weight:600;margin-top:2px;${it.ltr ? 'direction:ltr;text-align:right;unicode-bidi:isolate' : ''}">${esc(it.value)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function linesTable(caption: string, lines: InvoiceLine[]): string {
  return `
  <div style="margin-top:28px">
    <div style="font-size:13px;font-weight:600;color:${C.primary};margin-bottom:10px">${esc(caption)}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:${C.primary};color:#fff;text-align:right">
          <th style="padding:12px 16px;font-weight:600;font-size:12.5px">البند</th>
          <th style="padding:12px 16px;font-weight:600;font-size:12.5px;width:90px;text-align:center">الكمية</th>
          <th style="padding:12px 16px;font-weight:600;font-size:12.5px;width:130px;text-align:left">سعر الوحدة</th>
          <th style="padding:12px 16px;font-weight:600;font-size:12.5px;width:140px;text-align:left">المجموع</th>
        </tr>
      </thead>
      <tbody>
        ${lines.map((l) => `
        <tr style="border-bottom:1px solid ${C.border}">
          <td style="padding:14px 16px">
            <div style="font-weight:600">${esc(l.nameAr)}</div>
            ${l.descAr ? `<div style="font-size:11.5px;color:#7C6F74">${esc(l.descAr)}</div>` : ''}
            ${l.periodAr ? `<div style="font-size:11.5px;color:#7C6F74">${esc(l.periodAr)}</div>` : ''}
          </td>
          <td style="padding:14px 16px;text-align:center;color:${C.body}">${esc(l.qty)}</td>
          <td style="padding:14px 16px;text-align:left;direction:ltr;unicode-bidi:isolate;color:${C.body}">${jod(l.unitPrice)}</td>
          <td style="padding:14px 16px;text-align:left;font-weight:600;direction:ltr;unicode-bidi:isolate">${jod(l.lineTotal)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function detailsTable(caption: string, rows: InvoiceKeyValue[]): string {
  return `
  <div style="margin-top:26px">
    <div style="font-size:13px;font-weight:600;color:${C.primary};margin-bottom:10px">${esc(caption)}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid ${C.border};border-radius:10px;overflow:hidden">
      <tbody>
        ${rows.map((r, i) => `
        <tr${i < rows.length - 1 ? ` style="border-bottom:1px solid ${C.border}"` : ''}>
          <td style="padding:13px 18px;width:220px;color:${C.body};background:${C.tint};font-size:13px">${esc(r.label)}</td>
          <td style="padding:13px 18px;font-weight:600;${r.ltr ? 'direction:ltr;text-align:right;unicode-bidi:isolate' : ''}">${esc(r.value)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function statusBadge(status: NonNullable<InvoiceDoc['status']>): string {
  const t = STATUS_TONE[status.tone];
  return `
  <div style="display:inline-flex;align-items:center;gap:8px;background:${t.bg};border:1px solid ${t.border};color:${t.fg};padding:7px 14px;border-radius:100px;font-size:13.5px;font-weight:600">
    <span style="width:8px;height:8px;border-radius:50%;background:${t.dot}"></span>${esc(status.label)}
  </div>`;
}

function totalsBox(doc: InvoiceDoc): string {
  const rows = (doc.totals ?? []).map((t, i) => `
    <div style="display:flex;justify-content:space-between;padding:13px 18px;font-size:13.5px;${i ? `border-top:1px solid ${C.border};background:${C.tint};` : ''}">
      <span style="color:${C.body}">${esc(t.label)}</span>
      <span style="font-weight:600;direction:ltr;unicode-bidi:isolate;${t.negative ? `color:${C.primary}` : ''}">${t.negative ? '−' : ''}${jod(Math.abs(t.amount))}</span>
    </div>`).join('');

  const grand = doc.grandAmount === undefined ? '' : `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 18px;background:${C.primary};color:#fff;border-top:3px solid ${C.gold}">
      <span style="font-size:14px;font-weight:600">${esc(doc.grandLabel ?? 'الإجمالي')}</span>
      <span style="font-size:20px;font-weight:700;direction:ltr;unicode-bidi:isolate">${jod(doc.grandAmount)}</span>
    </div>`;

  return `<div style="width:330px;flex:none;border:1px solid ${C.border};border-radius:10px;overflow:hidden">${rows}${grand}</div>`;
}

function stampBox(stamp: NonNullable<InvoiceDoc['stamp']>): string {
  return `
  <div style="width:170px;flex:none;border:2px solid ${C.primary};border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:${C.primary};transform:rotate(-4deg);padding:10px">
    <div style="font-size:19px;font-weight:700;letter-spacing:1px">${esc(stamp.label)}</div>
    <div style="font-size:10px;color:${C.goldInk}">${esc(stamp.subLabel)}</div>
  </div>`;
}

export function renderInvoice(settings: InvoiceSettings, doc: InvoiceDoc): string {
  const showStamp = settings.showStamp && doc.stamp;

  // العمود الأيسر: الحالة والختم. الأيمن: المجاميع. أحدهما قد يغيب.
  const sideLeft = [
    doc.status
      ? `<div style="flex:1;border:1px solid ${C.border};border-radius:10px;padding:16px 18px;background:${C.tint}">
           <div style="font-size:11.5px;color:${C.label};font-weight:500">الحالة</div>
           <div style="margin-top:8px">${statusBadge(doc.status)}</div>
         </div>`
      : '',
    showStamp ? stampBox(doc.stamp!) : '',
  ].filter(Boolean).join('');

  const totalsRow =
    doc.totals?.length || doc.grandAmount !== undefined || sideLeft
      ? `<div style="display:flex;justify-content:space-between;gap:24px;margin-top:20px;align-items:flex-start">
           <div style="flex:1;display:flex;gap:16px;align-items:stretch">${sideLeft || '<div></div>'}</div>
           ${doc.totals?.length || doc.grandAmount !== undefined ? totalsBox(doc) : ''}
         </div>`
      : '';

  const footerLeft = [
    settings.showFinanceContact && settings.financeContact
      ? `<div>للاستفسارات المالية: ${esc(settings.financeContact)}</div>`
      : '',
    '<div>هذه الوثيقة صادرة إلكترونياً ولا تحتاج إلى توقيع أو ختم.</div>',
  ].join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.titleAr)} — ${esc(doc.number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#EFE9EB;font-family:"IBM Plex Sans Arabic",system-ui,sans-serif;color:${C.ink};font-size:14px;line-height:1.7}
  .sheet{width:210mm;min-height:297mm;margin:16px auto;background:#fff;padding:44px 48px 36px;display:flex;flex-direction:column;box-shadow:0 2px 12px rgba(35,26,29,.12)}
  .print-bar{max-width:210mm;margin:16px auto 0;display:flex;justify-content:flex-start}
  .print-bar button{background:${C.primary};color:#fff;border:0;border-radius:8px;padding:10px 22px;font:600 14px "IBM Plex Sans Arabic",sans-serif;cursor:pointer}
  /* الطباعة: الورقة وحدها بلا خلفية ولا زر */
  @media print{
    body{background:#fff}
    .print-bar{display:none}
    .sheet{width:auto;min-height:0;margin:0;padding:14mm 14mm 10mm;box-shadow:none}
    @page{size:A4;margin:0}
  }
</style>
</head>
<body>
<div class="print-bar"><button onclick="window.print()">🖨️ طباعة / حفظ PDF</button></div>
<div class="sheet">
  ${header(settings, doc)}
  ${infoGrid(doc.info)}
  ${doc.lines?.length ? linesTable(doc.tableCaptionAr ?? 'تفاصيل الفاتورة', doc.lines) : ''}
  ${doc.details?.length ? detailsTable(doc.tableCaptionAr ?? 'تفاصيل العملية', doc.details) : ''}
  ${totalsRow}
  ${doc.noteAr ? `<div style="margin-top:26px;border-right:3px solid ${C.gold};background:${C.goldTint};padding:12px 16px;font-size:12.5px;color:${C.body};border-radius:0 6px 6px 0">${esc(doc.noteAr)}</div>` : ''}
  ${settings.showFooterNote && settings.footerNoteAr ? `<div style="margin-top:14px;font-size:12px;color:${C.muted}">${esc(settings.footerNoteAr)}</div>` : ''}
  <div style="margin-top:auto;padding-top:24px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-top:1px solid ${C.border};font-size:11px;color:${C.label}">
    <div style="line-height:1.8">${footerLeft}</div>
    <div style="text-align:left">
      ${settings.showCompanyNameAr && settings.companyNameAr ? `<div style="font-weight:600;color:${C.primary}">${esc(settings.companyNameAr)}</div>` : ''}
      <div>صفحة 1 من 1 · <span style="direction:ltr;unicode-bidi:isolate">${esc(doc.number)}</span></div>
    </div>
  </div>
</div>
</body>
</html>`;
}

export { dateAr, jod };
