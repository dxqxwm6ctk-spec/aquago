/**
 * دور العملية: `api` يخدم الطلبات، `worker` يستهلك الطوابير.
 *
 * الصورة واحدة والكود واحد — المتغيّر `ROLE` وحده يقرر أي نصف يعمل. بلا هذا
 * الفصل كان كل حاوية API تُنشئ عاملَي BullMQ عند الإقلاع، فحاويتان تعنيان
 * مستهلكَين متنافسَين على نفس الطابور: لا تتضاعف المهمة (BullMQ يقفل عليها)
 * لكن يستحيل توسيع العمال بمعزل عن الـAPI، ويحمل كل خادم طلباتٍ حِمل التوزيع.
 *
 * القيمة غير المعروفة تُوقف الإقلاع بدل أن تُفسَّر `api` بصمت: خطأ مطبعي في
 * `ROLE=wroker` يعني طوابير بلا مستهلك — مؤقتات العروض لا تنطلق، والطلبات
 * تبقى في SEARCHING بلا رسالة خطأ واحدة.
 */
export type ProcessRole = 'api' | 'worker';

const VALID: readonly ProcessRole[] = ['api', 'worker'] as const;

export function processRole(): ProcessRole {
  const raw = (process.env.ROLE || 'api').trim().toLowerCase();
  if (!VALID.includes(raw as ProcessRole)) {
    throw new Error(
      `ROLE=${process.env.ROLE} غير معروف — القيم المقبولة: ${VALID.join(' | ')}`,
    );
  }
  return raw as ProcessRole;
}

/** هل تُشغّل هذه العملية مستهلكي الطوابير والمهام المجدولة؟ */
export function isWorker(): boolean {
  return processRole() === 'worker';
}

/** هل تخدم هذه العملية طلبات HTTP وWebSocket؟ */
export function isApi(): boolean {
  return processRole() === 'api';
}
