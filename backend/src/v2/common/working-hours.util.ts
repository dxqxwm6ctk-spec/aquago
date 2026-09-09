/**
 * ساعات دوام الوكالات — مصدر واحد يقرأه التوزيع وفحص التغطية معاً.
 *
 * **لماذا هنا لا في DispatchService**: الزبون يُمنع من الطلب خارج الدوام
 * (فحص التغطية)، والتوزيع يتخطّى الوكالة المغلقة. لو حمل كلٌّ نسخته من
 * المنطق لانحرفتا مع أول تعديل — فيُسمح بطلبٍ لا يجد وكالة، أو يُمنع طلبٌ
 * كانت ستقبله وكالة. والحالة الحادّة هنا (الدوام العابر لمنتصف الليل) هي
 * بالضبط ما يُنسى نقله بين نسختين.
 */

export const AMMAN_TZ = 'Asia/Amman';

export interface WorkingHourRow {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
}

export interface LocalNow {
  date: Date;
  minutes: number;
  weekday: number;
}

/**
 * اللحظة الحالية بتوقيت عمّان — تاريخُها ودقائقُها ويومُ أسبوعها.
 *
 * التاريخ يُبنى بـUTC من مكوّنات محلية عمداً: حقل `AgencyHoliday.date` من
 * نوع `@db.Date` بلا وقت، ومقارنته بلحظةٍ تحمل إزاحة منطقة كانت ستُزيح
 * الإجازة يوماً كاملاً قرب منتصف الليل.
 */
export function ammanNow(): LocalNow {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AMMAN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = new Date(Date.UTC(+get('year'), +get('month') - 1, +get('day')));
  return {
    date,
    minutes: +get('hour') * 60 + +get('minute'),
    weekday: date.getUTCDay(),
  };
}

/**
 * هل الوكالة ضمن دوامها الآن؟
 *
 * **الغياب يعني الفتح لا الإغلاق.** وكالة لم تُدخل جدول دوام تعمل على مدار
 * الساعة — والعكس كان سيُغلق كل وكالة قائمة لحظة تفعيل الميزة. المنادي هو
 * من يفحص `hours.length > 0` قبل النداء.
 *
 * والدوام العابر لمنتصف الليل مقصود التمثيل: «17:00 → 02:00» نافذة واحدة
 * تمتد لليوم التالي لا نافذة مقلوبة فارغة. الوكالات المسائية تعمل هكذا،
 * والمقارنة البسيطة (`from <= now < to`) كانت ستغلقها الليل كله.
 */
export function isWithinWorkingHours(
  hours: WorkingHourRow[],
  now: LocalNow,
): boolean {
  const toMinutes = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const total = +m[1] * 60 + +m[2];
    return Number.isFinite(total) ? total : null;
  };

  // اليوم الحالي، ونوافذ الأمس التي تمتد إلى اليوم (دوام عابر لمنتصف الليل)
  const yesterday = (now.weekday + 6) % 7;
  const relevant = hours.filter(
    (h) => h.dayOfWeek === now.weekday || h.dayOfWeek === yesterday,
  );
  if (relevant.length === 0) {
    // لا جدول لهذا اليوم إطلاقاً. إن كان للوكالة جدول لأيام أخرى فهذا يوم
    // عطلتها الأسبوعية؛ وإن لم يكن لها جدول أصلاً فالمنادي لم يصل هنا.
    return false;
  }

  for (const h of relevant) {
    const from = toMinutes(h.opensAt);
    const to = toMinutes(h.closesAt);
    // صفٌّ بصيغة وقت لا تُقرأ لا يُغلق الوكالة ولا يفتحها — يُتجاهَل
    if (from === null || to === null) continue;

    if (to > from) {
      // نافذة داخل اليوم نفسه
      if (h.dayOfWeek === now.weekday && now.minutes >= from && now.minutes < to) {
        return true;
      }
    } else {
      // تعبر منتصف الليل: من `from` إلى نهاية اليوم، ثم من الفجر إلى `to`
      if (h.dayOfWeek === now.weekday && now.minutes >= from) return true;
      if (h.dayOfWeek === yesterday && now.minutes < to) return true;
    }
  }
  return false;
}

/**
 * متى تفتح الوكالة بعد الآن؟ يُرجع الدقائق المتبقّية وساعة الفتح، أو `null`
 * إن لم يوجد فتحٌ قادم خلال أسبوع.
 *
 * **الغرض أن يعرف الزبون متى يعود.** «مغلقة الآن» وحدها تُنهي المحاولة؛
 * و«تفتح بعد ساعتين» تجعله ينتظر بدل أن ينصرف — وهو زبونٌ كان سيطلب.
 *
 * يمسح سبعة أيام قادمة دقيقةً بدقيقة على مستوى النوافذ لا الدقائق: لكل يوم
 * نجرّب نوافذه، فأبعد ما يُرجَع أسبوع. والوكالة بلا جدول لا تصل هنا أصلاً
 * (المنادي يفحص `hours.length`)، والوكالة التي كل جدولها تالف تُرجع `null`
 * فيُقال «مغلقة» بلا وعدٍ بموعد لا نعرفه.
 */
export function nextOpeningAt(
  hours: WorkingHourRow[],
  now: LocalNow,
): { minutesUntil: number; weekday: number; opensAt: string } | null {
  const toMinutes = (hhmm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const total = +m[1] * 60 + +m[2];
    return Number.isFinite(total) ? total : null;
  };

  let best: { minutesUntil: number; weekday: number; opensAt: string } | null =
    null;

  // يوم اليوم أولاً ثم ستة بعده — الأقرب يفوز، فنقف عند أول ما نجده مرتَّباً
  for (let offset = 0; offset < 7; offset++) {
    const weekday = (now.weekday + offset) % 7;
    for (const h of hours) {
      if (h.dayOfWeek !== weekday) continue;
      const from = toMinutes(h.opensAt);
      if (from === null) continue; // صفّ بصيغة لا تُقرأ — يُتجاهَل كما في isWithinWorkingHours

      // فتحٌ مضى اليوم لا يُحتسب: نريد القادم لا الفائت
      const minutesUntil = offset * 24 * 60 + from - now.minutes;
      if (minutesUntil <= 0) continue;

      if (!best || minutesUntil < best.minutesUntil) {
        best = { minutesUntil, weekday, opensAt: h.opensAt.trim() };
      }
    }
    // وجدنا فتحاً في يومٍ ما: أي يوم لاحق أبعد بالضرورة، فلا داعي للمسح
    if (best) break;
  }

  return best;
}

/**
 * يصوغ «تفتح بعد ساعتين» بالعربية من دقائق.
 *
 * **التثنية والجمع مقصودان**: العربية تميّز الواحد والاثنين والقلّة والكثرة،
 * و«بعد 2 ساعة» تُقرأ ترجمةً آلية لا كلاماً. والقاعدة هنا مبسّطة عمداً —
 * تكفي مدى ما نعرضه (دقائق إلى أيام) ولا تدّعي عموماً.
 *
 * يُرجع نصّاً فارغاً حين لا موعد معروف: «مغلقة الآن» وحدها أصدق من وعدٍ
 * بموعد لا نملكه.
 */
export function describeOpensIn(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return ' — جرّب خلال ساعات الدوام';

  if (minutes < 60) {
    const m = Math.max(1, Math.round(minutes));
    if (m === 1) return ' — تفتح بعد دقيقة';
    if (m === 2) return ' — تفتح بعد دقيقتين';
    return m <= 10 ? ` — تفتح بعد ${m} دقائق` : ` — تفتح بعد ${m} دقيقة`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    if (hours === 1) return ' — تفتح بعد ساعة';
    if (hours === 2) return ' — تفتح بعد ساعتين';
    return hours <= 10 ? ` — تفتح بعد ${hours} ساعات` : ` — تفتح بعد ${hours} ساعة`;
  }

  const days = Math.round(hours / 24);
  if (days === 1) return ' — تفتح غداً';
  if (days === 2) return ' — تفتح بعد يومين';
  return days <= 10 ? ` — تفتح بعد ${days} أيام` : ` — تفتح بعد ${days} يوماً`;
}
