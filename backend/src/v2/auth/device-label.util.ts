import type { Request } from 'express';

/** أطول مما تحتاجه أي تسمية جهاز — يمنع حشو الحقل بترويسة ضخمة */
const MAX_LENGTH = 120;

/**
 * تسمية الجهاز كما تظهر لأدمن المنصة في شاشة «الأجهزة».
 *
 * تفضّل ترويسة `X-Device` التي ترسلها التطبيقات: وكيل المستخدم الافتراضي في
 * Flutter هو `Dart/3.x (dart:io)` لكل الأجهزة بلا تمييز، فقائمةٌ منه لا تقول
 * للأدمن أي جهاز يُخرج. تتراجع إلى `User-Agent` للمتصفحات (لوحات التحكم)
 * حيث يحمل فعلاً نظام التشغيل والمتصفح.
 */
export function deviceLabel(req: Request): string | undefined {
  const raw = req.headers['x-device'] ?? req.headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_LENGTH);
}
