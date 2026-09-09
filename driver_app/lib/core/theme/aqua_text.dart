import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// أنماط النص لتطبيق AquaGo — عربي (IBM Plex Sans Arabic) للمحتوى،
/// ولاتيني (Space Grotesk) للأرقام والمعرّفات وسجلّات الوقت، طبقًا
/// لتصميم Claude Design الأصلي.
///
/// نسخ متعمَّد بين customer_app وdriver_app (SKILL.md) — لا حزمة مشتركة.
class AquaText {
  AquaText._();

  /// اسم عائلة الخط المسجَّلة في pubspec — ملفات محلية لا `google_fonts`.
  /// السبب مشروح عند تسجيلها هناك (تصيير معطوب للوزن 700، واعتماد على
  /// الشبكة عند أول تشغيل).
  static const _arabicFamily = 'IBMPlexSansArabic';

  static TextStyle arabic({
    double size = 14,
    FontWeight weight = FontWeight.w400,
    Color? color,
    double? height,
  }) =>
      TextStyle(
        fontFamily: _arabicFamily,
        fontSize: size,
        fontWeight: weight,
        color: color,
        height: height,
      );

  static TextStyle numeric({
    double size = 14,
    FontWeight weight = FontWeight.w600,
    Color? color,
    double? letterSpacing,
  }) =>
      GoogleFonts.spaceGrotesk(
        fontSize: size,
        fontWeight: weight,
        color: color,
        letterSpacing: letterSpacing,
      );
}
