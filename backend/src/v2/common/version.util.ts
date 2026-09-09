/**
 * يقارن نسختين بصيغة نقطية (1.12.0) رقمياً لا نصياً — فرز نصي كان سيضع
 * "1.9.0" فوق "1.10.0" لأن '9' > '1' حرفياً.
 *
 * يرجع رقماً سالباً إن كانت a أقدم من b، موجباً إن كانت أحدث، وصفراً إن تساوتا.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
