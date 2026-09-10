// إعدادات Firebase لتطبيق السائق — مشروع aqua-go-7cdd9.
//
// يقابل ما يولّده `flutterfire configure`، وقيمه منسوخة من الملفين
// الرسميين المنزَّلين من الكونسول:
//   android/app/google-services.json   (jo.aquago.driver)
//   ios/Runner/GoogleService-Info.plist (jo.aquago.driver)
//
// **هذا الملف يُلتزَم في git، وليس تسريباً.** مفاتيح Firebase العميلة
// مضمّنة في كل نسخة تُوزَّع من التطبيق ويستطيع أي أحد استخراجها من الـAPK،
// فحمايتها من قواعد الأمان (Security Rules) وقيود المفتاح في كونسول
// Google Cloud لا من إخفاء الملف. المفتاح السرّي الوحيد هو حساب الخدمة
// في الخادم (`FIREBASE_SERVICE_ACCOUNT_BASE64`) وهو ليس هنا.
//
// **معرّفات هذا الملف تخصّ السائق وحده.** خلطها بمعرّفات الزبون يجعل
// عروض التوصيل تصل لتطبيق الزبون — وهو العطل نفسه الذي يمنعه حقل `app`
// في تسجيل الجهاز (docs/NOTIFICATIONS_GUIDE.md §1).
//
// عند تغيير أي معرّف حزمة أو إضافة منصّة: أعد التوليد بـ
// `flutterfire configure` بدل التعديل اليدوي — خطأ حرف واحد هنا يعطي
// تهيئةً تنجح ظاهرياً ثم لا يصل إشعار واحد، بلا رسالة خطأ في أي مكان.

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;

/// خيارات Firebase الافتراضية لهذا التطبيق حسب المنصّة.
class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError(
        'الويب غير مهيّأ في Firebase لهذا التطبيق — أضِفه بـ'
        '`flutterfire configure --platforms=web` إن لزم.',
      );
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      // بقية المنصّات غير مسجَّلة عمداً: التطبيق للهاتف، ورميُ خطأ صريح
      // أوضح من تهيئةٍ بقيم منصّة أخرى.
      case TargetPlatform.macOS:
      case TargetPlatform.windows:
      case TargetPlatform.linux:
      case TargetPlatform.fuchsia:
        throw UnsupportedError(
          'لا إعدادات Firebase لـ$defaultTargetPlatform في تطبيق السائق.',
        );
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyBBofUxSLyYbXziHPouluht-4ynAy_HxP0',
    appId: '1:276428851477:android:d69ce77fc46a735495811c',
    messagingSenderId: '276428851477',
    projectId: 'aqua-go-7cdd9',
    storageBucket: 'aqua-go-7cdd9.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyBV9Lz8e8JOg7MKby9DwqZPoUYc3TC-j3A',
    appId: '1:276428851477:ios:8628c03e76b1b8f395811c',
    messagingSenderId: '276428851477',
    projectId: 'aqua-go-7cdd9',
    storageBucket: 'aqua-go-7cdd9.firebasestorage.app',
    iosBundleId: 'jo.aquago.driver',
  );
}
