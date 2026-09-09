import { escapeHtml } from './contract.catalog';

/**
 * تصيير العقد — HTML يُطبع من المتصفح (طباعة ← حفظ كـPDF)، لنفس سبب
 * الفاتورة: مكتبة PDF تضيف اعتماداً ثقيلاً وخطوطاً عربية مضمَّنة يدوياً،
 * ولا تعطي شيئاً لا تعطيه الطباعة. وRTL والخطوط العربية تعمل هنا بلا حيلة.
 *
 * ألوان AquaGo: العنابي #A41442، الذهبي #E2A82F، Ink #111B36.
 */

const C = {
  primary: '#A41442',
  dark: '#7D0F33',
  gold: '#E2A82F',
  ink: '#111B36',
  body: '#2E3648',
  muted: '#6E7691',
  line: '#E6E1D9',
  soft: '#FBF9F6',
} as const;

export interface SignatureBlock {
  sideAr: string;
  partyName: string;
  signerName: string;
  signerRole?: string | null;
  signerPhone?: string | null;
  signedAt?: Date | null;
  verificationAr?: string | null;
  ip?: string | null;
  /** صورة التوقيع المرسوم كـdata: URI جاهزة للإدراج */
  signatureDataUri?: string | null;
}

export interface ContractDoc {
  number: string;
  titleAr: string;
  bodyHtml: string;
  contentHash: string;
  templateVersion: number;
  statusAr: string;
  agencySignature?: SignatureBlock | null;
  platformSignature?: SignatureBlock | null;
  /** يُطبع في الترويسة حين لا يكون العقد نافذاً بعد */
  watermarkAr?: string | null;
}

const fmt = (d?: Date | null) =>
  d
    ? new Date(d).toLocaleString('ar-JO', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

/**
 * خانة توقيع واحدة. الفراغ المنقّط يبقى مطبوعاً حتى مع وجود توقيع
 * إلكتروني: النسخة تُطبع وتُوقّع بالحبر وتُختم (المادة ٢٨)، فالمكان
 * المخصص للحبر والختم جزء من الوثيقة لا زينة فيها.
 */
function signatureCell(s: SignatureBlock | null | undefined, fallbackSideAr: string): string {
  if (!s) {
    return `<div class="sig">
      <div class="sig-h">${escapeHtml(fallbackSideAr)}</div>
      <div class="sig-row"><span>الاسم</span><i></i></div>
      <div class="sig-row"><span>الصفة</span><i></i></div>
      <div class="sig-row"><span>التوقيع</span><i></i></div>
      <div class="sig-row"><span>الختم</span><i></i></div>
      <div class="sig-row"><span>التاريخ</span><i></i></div>
    </div>`;
  }
  return `<div class="sig">
    <div class="sig-h">${escapeHtml(s.sideAr)}</div>
    <div class="sig-row"><span>الجهة</span><b>${escapeHtml(s.partyName)}</b></div>
    <div class="sig-row"><span>الاسم</span><b>${escapeHtml(s.signerName)}</b></div>
    <div class="sig-row"><span>الصفة</span><b>${escapeHtml(s.signerRole || '—')}</b></div>
    ${
      s.signatureDataUri
        ? `<div class="sig-img"><img src="${s.signatureDataUri}" alt="التوقيع" /></div>`
        : '<div class="sig-row"><span>التوقيع</span><i></i></div>'
    }
    <div class="sig-row"><span>الختم</span><i></i></div>
    <div class="sig-row"><span>التاريخ</span><b>${fmt(s.signedAt)}</b></div>
  </div>`;
}

/**
 * شهادة الإتمام — الصفحة التي تصنع الفرق بين عقدٍ يصمد وعقدٍ لا يصمد.
 *
 * صورة الإمضاء وحدها تُقصّ وتُلصق؛ ما لا يُزوَّر بسهولة هو اقتران بصمة
 * الوثيقة بوقتٍ وعنوانٍ ووسيلة تحقّق مسجّلة. لذلك تُطبع البصمة كاملة على
 * الورقة: من طبع نسخة وعدّل فيها حرفاً، تكذّبه البصمة المطبوعة.
 */
function certificate(doc: ContractDoc): string {
  const row = (label: string, value: string, ltr = false) =>
    `<tr><th>${escapeHtml(label)}</th><td class="${ltr ? 'ltr' : ''}">${escapeHtml(value)}</td></tr>`;

  const party = (s: SignatureBlock | null | undefined, sideAr: string) =>
    !s
      ? `<tr><th>${escapeHtml(sideAr)}</th><td>لم يوقّع بعد</td></tr>`
      : `<tr><th>${escapeHtml(sideAr)}</th><td>
          ${escapeHtml(s.signerName)}${s.signerRole ? ' — ' + escapeHtml(s.signerRole) : ''}<br>
          <span class="cert-sub">وقّع في ${fmt(s.signedAt)}
          ${s.verificationAr ? ' · التحقق: ' + escapeHtml(s.verificationAr) : ''}
          ${s.ip ? ' · IP: ' + escapeHtml(s.ip) : ''}
          ${s.signerPhone ? ' · الهاتف المسجّل: ' + escapeHtml(s.signerPhone) : ''}</span>
        </td></tr>`;

  return `<div class="cert page-break">
    <h2>شهادة إتمام التوقيع الإلكتروني</h2>
    <p class="cert-note">تُصدَر هذه الصفحة آلياً من نظام AquaGo وتشكّل جزءاً من سجلّ الأدلة الإلكترونية المشار إليه في المادتين 26 و27 من هذا العقد.</p>
    <table class="cert-t">
      ${row('رقم العقد', doc.number, true)}
      ${row('نسخة القالب', String(doc.templateVersion))}
      ${row('حالة العقد', doc.statusAr)}
      ${party(doc.agencySignature, 'الطرف الثاني — الوكالة')}
      ${party(doc.platformSignature, 'الطرف الأول — AquaGo')}
      ${row('بصمة الوثيقة SHA-256', doc.contentHash, true)}
    </table>
    <p class="cert-note">البصمة أعلاه محسوبة على نصّ العقد لحظة توليده. أي تعديل على النص — ولو بحرف واحد — يُنتج بصمة مختلفة، وبذلك تُكشف أي نسخة غير مطابقة للأصل.</p>
  </div>`;
}

export function renderContract(doc: ContractDoc): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.titleAr)} — ${escapeHtml(doc.number)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#EDEAE4;color:${C.body};
       font:15px/1.95 "IBM Plex Sans Arabic",system-ui,sans-serif}
  .sheet{max-width:210mm;margin:0 auto;background:#fff;padding:22mm 18mm 18mm;
         box-shadow:0 4px 24px rgba(0,0,0,.10)}
  .brand{display:flex;align-items:center;justify-content:space-between;gap:16px;
         border-bottom:3px solid ${C.primary};padding-bottom:14px;margin-bottom:8px}
  .brand-name{font-size:26px;font-weight:700;color:${C.primary};letter-spacing:-.5px}
  .brand-meta{text-align:left;font-family:"IBM Plex Mono",monospace;font-size:12px;color:${C.muted}}
  .wm{margin:14px 0;padding:10px 14px;border-radius:8px;background:#FDF6E7;
      border:1px solid #F0DFB4;color:#7A6320;font-size:13px;font-weight:600}
  h1{font-size:21px;color:${C.ink};margin:22px 0 6px;line-height:1.6}
  h2{font-size:16px;color:${C.primary};margin:24px 0 8px;padding-bottom:5px;
     border-bottom:1px solid ${C.line};page-break-after:avoid}
  h3{font-size:15px;color:${C.ink};margin:18px 0 6px;page-break-after:avoid}
  p{margin:6px 0}
  p.sub{margin-right:18px;color:${C.muted}}
  p.meta{font-size:13.5px;color:${C.muted};margin-bottom:16px}
  p.highlight{background:${C.soft};border:1px solid ${C.line};border-radius:8px;
              padding:10px 14px;margin:10px 0}
  p.stamp-duty:empty{display:none}
  .ltr{direction:ltr;unicode-bidi:embed;display:inline-block;
       font-family:"IBM Plex Mono",monospace}
  table.deal{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
  table.deal th{width:38%;text-align:right;background:${C.soft};color:${C.ink};
                font-weight:600;padding:9px 12px;border:1px solid ${C.line}}
  table.deal td{padding:9px 12px;border:1px solid ${C.line}}
  /* ---- التواقيع ---- */
  .sigs{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:26px;
        page-break-inside:avoid}
  .sig{border:1px solid ${C.line};border-radius:10px;padding:14px 16px;background:#fff}
  .sig-h{font-weight:700;color:${C.primary};font-size:14px;margin-bottom:10px;
         padding-bottom:8px;border-bottom:1px solid ${C.line}}
  .sig-row{display:flex;align-items:baseline;gap:10px;font-size:13px;margin:9px 0}
  .sig-row span{color:${C.muted};min-width:52px}
  .sig-row i{flex:1;border-bottom:1px dotted #B9B2A6;height:15px}
  .sig-row b{font-weight:600;color:${C.ink}}
  .sig-img{margin:10px 0;padding:6px;border:1px solid ${C.line};border-radius:8px;
           background:#fff;text-align:center}
  .sig-img img{max-width:100%;max-height:70px}
  /* ---- شهادة الإتمام ---- */
  .cert{margin-top:30px;border:2px solid ${C.gold};border-radius:12px;padding:20px 22px;
        background:#FEFCF7}
  .cert h2{border:0;margin:0 0 6px;color:${C.dark}}
  .cert-note{font-size:12.5px;color:${C.muted};line-height:1.85}
  .cert-t{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
  .cert-t th{width:32%;text-align:right;padding:8px 10px;border-bottom:1px solid #EFE3CB;
             color:${C.muted};font-weight:600;vertical-align:top}
  .cert-t td{padding:8px 10px;border-bottom:1px solid #EFE3CB;color:${C.ink};
             word-break:break-all}
  .cert-sub{color:${C.muted};font-size:11.5px;word-break:normal}
  .foot{margin-top:22px;padding-top:12px;border-top:1px solid ${C.line};
        font-size:11px;color:${C.muted};display:flex;justify-content:space-between;gap:12px}
  .foot .hash{font-family:"IBM Plex Mono",monospace;direction:ltr;word-break:break-all}
  .bar{max-width:210mm;margin:16px auto 0;display:flex;gap:10px}
  .bar button{background:${C.primary};color:#fff;border:0;border-radius:8px;
              padding:11px 24px;font:600 14px "IBM Plex Sans Arabic",sans-serif;cursor:pointer}
  .bar button:hover{background:${C.dark}}
  .page-break{page-break-before:always}
  @media print{
    body{background:#fff}
    .sheet{box-shadow:none;max-width:none;padding:14mm 12mm}
    .bar{display:none}
    @page{size:A4;margin:12mm}
  }
</style>
</head>
<body>
<div class="bar"><button onclick="window.print()">🖨️ طباعة / حفظ PDF</button></div>
<div class="sheet">
  <div class="brand">
    <div class="brand-name">AquaGo</div>
    <div class="brand-meta">${escapeHtml(doc.number)}<br>نسخة القالب ${doc.templateVersion}</div>
  </div>
  ${doc.watermarkAr ? `<div class="wm">${escapeHtml(doc.watermarkAr)}</div>` : ''}

  ${doc.bodyHtml}

  <div class="sigs">
    ${signatureCell(doc.platformSignature, 'توقيع الطرف الأول — AquaGo')}
    ${signatureCell(doc.agencySignature, 'توقيع الطرف الثاني — الوكالة')}
  </div>

  ${certificate(doc)}

  <div class="foot">
    <span>${escapeHtml(doc.titleAr)}</span>
    <span class="hash">SHA-256: ${escapeHtml(doc.contentHash)}</span>
  </div>
</div>
</body>
</html>`;
}
