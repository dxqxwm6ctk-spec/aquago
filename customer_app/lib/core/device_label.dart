import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

/// تسمية الجهاز التي تُرسل في ترويسة `X-Device`، وتظهر للأدمن في شاشة
/// «الأجهزة» عند اختيار جهاز لإخراجه.
///
/// وكيل المستخدم الافتراضي في Flutter هو `Dart/3.x (dart:io)` لكل الأجهزة بلا
/// تمييز، فقائمةٌ منه لا تقول للأدمن أيّ جهاز يُخرج — ولذلك يفضّل الخادم هذه
/// الترويسة عليه (`device-label.util.ts`).
///
/// تُحسب مرة واحدة وتُحفظ: قراءة معلومات الجهاز نداءُ قناة إلى المنصة، ولا
/// معنى لتكراره مع كل طلب شبكة.
String? _cached;

/// **ترويسات HTTP تقبل ASCII وحده.** أي محرف خارجه يجعل `dart:io` يرمي
/// `FormatException` عند تكوين الطلب — فيسقط النداء قبل أن يغادر الجهاز،
/// ويظهر العطل كفشل خادم وهو لم يصله أصلاً.
///
/// وهذا ما حدث فعلاً: الفاصل `·` (U+00B7) في التسمية أسقط **كل** طلبات
/// الشبكة لا الدخول وحده — `X-Device` تُرسل مع كل نداء.
///
/// التعقيم على الناتج كله لا على الفاصل وحده: `manufacturer` و`model` يأتيان
/// من الجهاز نفسه وقد يحملان أي محرف، فحذف `·` وحده كان يترك الباب مفتوحاً
/// لجهازٍ اسمه بغير اللاتينية أن يُعيد العطل من طريق آخر.
/// مكشوفة للاختبار: التسمية الحقيقية تتفرّع على المنصّة، وبيئة الاختبار
/// ليست أندرويد — فاختبارُ `deviceLabel()` وحدها يفحص ثابتاً لا يمرّ بالفرع
/// المكسور أصلاً، ويمرّ أخضرَ على العطل القائم.
@visibleForTesting
String asciiSafe(String s) {
  final out = StringBuffer();
  for (final r in s.runes) {
    // المدى المطبوع من ASCII: من المسافة (0x20) إلى ‎`~`‎ (0x7E).
    out.writeCharCode(r >= 0x20 && r <= 0x7E ? r : 0x3F); // 0x3F = '?'
  }
  return out.toString();
}

Future<String> deviceLabel() async {
  final cached = _cached;
  if (cached != null) return cached;

  var label = 'AquaGo';
  try {
    final info = DeviceInfoPlugin();
    if (Platform.isAndroid) {
      final a = await info.androidInfo;
      label = 'AquaGo Android - ${a.manufacturer} ${a.model} (SDK ${a.version.sdkInt})';
    } else if (Platform.isIOS) {
      final i = await info.iosInfo;
      label = 'AquaGo iOS - ${i.utsname.machine} (${i.systemVersion})';
    }
  } catch (e) {
    // تسمية ناقصة أفضل من طلب فاشل: الترويسة وصفية لا تؤثّر في التحقق.
    debugPrint('[auth] تعذّرت قراءة معلومات الجهاز: $e');
  }

  // التعقيم قبل القصّ: بعده قد يقع الحدّ داخل زوجٍ بديل فينكسر المحرف.
  label = asciiSafe(label);

  // الخادم يقصّ عند ١٢٠ محرفاً — نقصّ هنا ليبقى ما نرسله هو ما يُخزَّن.
  if (label.length > 120) label = label.substring(0, 120);
  return _cached = label;
}
