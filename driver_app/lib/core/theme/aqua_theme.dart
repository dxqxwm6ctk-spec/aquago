import 'package:flutter/material.dart';
import 'aqua_colors.dart';
import 'aqua_text.dart';

/// نصف قطر الزوايا القياسي — من `radii` في `aquago-tokens.json`.
class AquaRadii {
  AquaRadii._();
  static const double pill = 999;
  static const double card = 26;
  static const double md = 20;
  static const double button = 16;
  static const double sm = 12;
}

/// بناء `ThemeData` لتطبيق السائق من رموز AquaGo، بفرعين فاتح وداكن
/// عبر `context.colors` (امتداد أدناه) بدل تكرار الألوان بكل شاشة.
class AquaTheme {
  AquaTheme._();

  static ThemeData light() => _build(AquaColors.light, Brightness.light);
  static ThemeData dark() => _build(AquaColors.dark, Brightness.dark);

  static ThemeData _build(AquaColors colors, Brightness brightness) {
    final base = ThemeData(brightness: brightness, useMaterial3: true);
    return base.copyWith(
      scaffoldBackgroundColor: colors.bg,
      colorScheme: ColorScheme.fromSeed(
        seedColor: colors.aqua,
        brightness: brightness,
        primary: colors.deep,
        surface: colors.surface,
      ),
      textTheme: GoogleFontsArabicTextTheme.build(base.textTheme, colors),
      extensions: [colors],
    );
  }
}

/// اختصار قراءة الألوان الحالية من الشجرة — `context.colors.deep` بدل
/// `Theme.of(context).extension<AquaColors>()!.deep` في كل مكان.
extension AquaColorsContext on BuildContext {
  AquaColors get colors => Theme.of(this).extension<AquaColors>()!;
}

/// يبني `TextTheme` افتراضيًا بخط IBM Plex Sans Arabic — الشاشات تستخدم
/// `AquaText.arabic/numeric` مباشرة للحالات الخاصة (الأرقام، المعرّفات).
class GoogleFontsArabicTextTheme {
  static TextTheme build(TextTheme base, AquaColors colors) {
    return base.copyWith(
      bodyMedium: AquaText.arabic(size: 13.5, color: colors.ink),
      titleLarge: AquaText.arabic(size: 22, weight: FontWeight.w700, color: colors.ink),
      titleMedium: AquaText.arabic(size: 16, weight: FontWeight.w600, color: colors.ink),
    );
  }
}
