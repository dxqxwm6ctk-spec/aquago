import 'package:flutter/material.dart';

/// ألوان AquaGo — منسوخة حرفيًا عن `assets/aquago-tokens.json` في مشروع
/// Claude Design (Aqua Go Water Delivery)، وهي نفسها لكل تطبيقات
/// المنصة (الزبون، السائق، لوحات الإدارة) — علامة واحدة موحّدة.
///
/// النسخة الداكنة غير موجودة في ملف الـtokens الأصلي (المصمَّم بخلفية
/// فاتحة فقط)، فبُنيت هنا بعكس منطقي متّسق: نفس ألوان العلامة
/// (brand/status) بلا تغيير، والمحايدات (neutral) معكوسة سلّمًا
/// (`ink` يصبح الخلفية، `bg` يصبح لون النص) — يُعاد ضبطها لاحقًا لو
/// وصل تصميم داكن رسمي من Claude Design.
///
/// ملاحظة تكرار مقصود: هذا الملف مطابق حرفيًا لنظيره في customer_app —
/// النسخ المتعمَّد بين التطبيقين أرخص من حزمة مشتركة تُجبر كليهما على
/// التغيّر معًا (SKILL.md). أي تعديل هنا يجب أن يتكرر هناك بنفس الاسم.
class AquaColors extends ThemeExtension<AquaColors> {
  const AquaColors({
    required this.deep,
    required this.aqua,
    required this.teal,
    required this.sky,
    required this.sky300,
    required this.sky200,
    required this.sky100,
    required this.sky050,
    required this.ink,
    required this.surfaceDark,
    required this.ink2,
    required this.ink3,
    required this.ink4,
    required this.line2,
    required this.line,
    required this.bg,
    required this.bg2,
    required this.surface,
    required this.successFg,
    required this.successBg,
    required this.warningFg,
    required this.warningBg,
    required this.warningStrong,
    required this.dangerFg,
    required this.dangerBg,
    required this.infoFg,
    required this.infoBg,
  });

  final Color deep;
  final Color aqua;
  final Color teal;
  final Color sky;
  final Color sky300;
  final Color sky200;
  final Color sky100;
  final Color sky050;

  final Color ink;
  final Color surfaceDark;
  final Color ink2;
  final Color ink3;
  final Color ink4;
  final Color line2;
  final Color line;
  final Color bg;
  final Color bg2;
  final Color surface;

  final Color successFg;
  final Color successBg;
  final Color warningFg;
  final Color warningBg;
  final Color warningStrong;
  final Color dangerFg;
  final Color dangerBg;
  final Color infoFg;
  final Color infoBg;

  static const light = AquaColors(
    deep: Color(0xFF075985),
    aqua: Color(0xFF06B6D4),
    teal: Color(0xFF0E7490),
    sky: Color(0xFF38BDF8),
    sky300: Color(0xFF7DD3FC),
    sky200: Color(0xFFBAE6FD),
    sky100: Color(0xFFE0F2FE),
    sky050: Color(0xFFF0F9FF),
    ink: Color(0xFF0F172A),
    surfaceDark: Color(0xFF1E293B),
    ink2: Color(0xFF475569),
    ink3: Color(0xFF64748B),
    ink4: Color(0xFF94A3B8),
    line2: Color(0xFFCBD5E1),
    line: Color(0xFFE2E8F0),
    bg: Color(0xFFF1F5F9),
    bg2: Color(0xFFF8FAFC),
    surface: Colors.white,
    successFg: Color(0xFF15803D),
    successBg: Color(0xFFDCFCE7),
    warningFg: Color(0xFF92400E),
    warningBg: Color(0xFFFEF3C7),
    warningStrong: Color(0xFFB45309),
    dangerFg: Color(0xFFB91C1C),
    dangerBg: Color(0xFFFEE2E2),
    infoFg: Color(0xFF0E7490),
    infoBg: Color(0xFFCFFAFE),
  );

  static const dark = AquaColors(
    deep: Color(0xFF075985),
    aqua: Color(0xFF06B6D4),
    teal: Color(0xFF0E7490),
    sky: Color(0xFF38BDF8),
    sky300: Color(0xFF7DD3FC),
    sky200: Color(0xFF0C4A6E),
    sky100: Color(0xFF083344),
    sky050: Color(0xFF062434),
    ink: Color(0xFFF1F5F9),
    surfaceDark: Color(0xFFE2E8F0),
    ink2: Color(0xFFCBD5E1),
    ink3: Color(0xFF94A3B8),
    ink4: Color(0xFF64748B),
    line2: Color(0xFF334155),
    line: Color(0xFF1E293B),
    bg: Color(0xFF0B1220),
    bg2: Color(0xFF111C2E),
    surface: Color(0xFF16213A),
    successFg: Color(0xFF4ADE80),
    successBg: Color(0xFF0F2E1A),
    warningFg: Color(0xFFFBBF24),
    warningBg: Color(0xFF2E2007),
    warningStrong: Color(0xFFF59E0B),
    dangerFg: Color(0xFFF87171),
    dangerBg: Color(0xFF2E0E0E),
    infoFg: Color(0xFF67E8F9),
    infoBg: Color(0xFF0B2A30),
  );

  /// تدرّج الأزرار الأساسية (بدء التوصيل، الخطوة التالية...).
  static const buttonGradient = LinearGradient(
    begin: Alignment(-1, -1),
    end: Alignment(1, 1),
    colors: [Color(0xFF075985), Color(0xFF06B6D4)],
  );

  /// تدرّج البطاقات البارزة (الأرباح الأسبوعية، الوردية النشطة...).
  static const heroGradient = LinearGradient(
    begin: Alignment(-0.7, -1),
    end: Alignment(0.7, 1),
    colors: [Color(0xFF075985), Color(0xFF0E7490), Color(0xFF06B6D4)],
    stops: [0, 0.6, 1],
  );

  /// تدرّج شعار العلامة (الأيقونة، الأفاتار).
  static const markGradient = LinearGradient(
    begin: Alignment(-1, -1),
    end: Alignment(1, 1),
    colors: [Color(0xFF38BDF8), Color(0xFF06B6D4), Color(0xFF075985)],
    stops: [0, 0.55, 1],
  );

  /// لون "متصل" الخاص بالسائق (مفتاح الوردية) — من لوحة الرموز
  /// الخاصة بتطبيق السائق في التصميم الأصلي (Driver-only tokens).
  static const onlineColor = Color(0xFF06B6D4);
  static const offlineColor = Color(0xFF0F172A);

  @override
  AquaColors copyWith() => this;

  @override
  AquaColors lerp(ThemeExtension<AquaColors>? other, double t) {
    if (other is! AquaColors) return this;
    return t < 0.5 ? this : other;
  }
}
