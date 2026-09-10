import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart' as fb;
import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

/// **هل تهيّأت Firebase؟** يضبطه `main` عند الإقلاع.
///
/// فشل `Firebase.initializeApp` لا يعطّل الإشعارات وحدها كما يوحي موضعه في
/// `main`: الدخول بجوجل وآبل يمرّ بـ`FirebaseAuth.instance` كذلك، فينهار
/// المساران معاً. وبلا هذا العلم كان الانهيار يصل الزبون كـ«تعذّر إتمام
/// الدخول — أعد المحاولة»، وهي رسالة تَعِد بما لا يُجدي: العطل دائم لا
/// عابر، وإعادة المحاولة تُنتجه حرفياً إلى ما لا نهاية.
bool firebaseReady = false;

/// تهيئة Firebase غائبة — عطلٌ في التطبيق لا في محاولة المستخدم.
class FirebaseUnavailable implements Exception {
  const FirebaseUnavailable();

  @override
  String toString() => 'FirebaseUnavailable';
}

/// أغلق المستخدم نافذة الاختيار — إلغاءٌ مقصود لا عطل، والشاشة تبتلعه بلا
/// رسالة خطأ حمراء.
class SocialSignInCancelled implements Exception {
  const SocialSignInCancelled();

  @override
  String toString() => 'SocialSignInCancelled';
}

/// نتيجة الدخول الاجتماعي: مسار الخادم الذي يستقبلها، وتوكن الهوية من
/// Firebase الذي يتحقق منه الخادم ويصدر توكنيه مقابله.
@immutable
class SocialIdToken {
  const SocialIdToken(this.path, this.idToken);

  final String path;
  final String idToken;
}

/// **دخول جوجل — المسار الأساسي.** يفتح اختيار الحساب، يبادل نتيجته بجلسة
/// Firebase، ثم يسلّم الـID token للخادم الذي يتحقق منه ويصدر توكناته.
///
/// لا اسم يُرسَل: الخادم يقرأه من التوكن نفسه، وهو مصدر لا يقبل التزوير خلاف
/// حقل نصّي يملؤه التطبيق.
Future<SocialIdToken> googleIdToken() async {
  if (!firebaseReady) throw const FirebaseUnavailable();
  final googleUser = await GoogleSignIn().signIn();
  if (googleUser == null) throw const SocialSignInCancelled();
  final googleAuth = await googleUser.authentication;
  final cred = fb.GoogleAuthProvider.credential(
    idToken: googleAuth.idToken,
    accessToken: googleAuth.accessToken,
  );
  final result = await fb.FirebaseAuth.instance.signInWithCredential(cred);
  final idToken = await result.user?.getIdToken();
  if (idToken == null) {
    throw Exception('تعذّر إتمام الدخول بجوجل — أعد المحاولة');
  }
  return SocialIdToken('/auth/google-login', idToken);
}

/// هل يُعرض زرّ آبل؟ على iOS وحده: على أندرويد يمرّ المسار بمتصفح ويب ويحتاج
/// Services ID ونطاق عودة، وهو تعقيد بلا مستفيد — لمستخدم أندرويد جوجلُ أقرب.
///
/// وآبل تشترط عرض دخولها على كل تطبيق يعرض دخولاً بمزوّد خارجي
/// (Guideline 4.8)، فغيابه على iOS يعني رفض النسخة عند المراجعة.
bool get appleSignInAvailable => !kIsWeb && Platform.isIOS;

/// **دخول آبل** — نظير [googleIdToken] على iOS وحده.
///
/// **الـnonce ليس زينة**: نُرسل تجزئته (SHA-256) إلى آبل ونسلّم الأصل إلى
/// Firebase، فيتأكد أن التوكن صدر لهذا الطلب بعينه لا أنه توكن مُلتقط من جلسة
/// أخرى يُعاد استعماله. Firebase يرفض التوكن بلا هذه المطابقة.
Future<SocialIdToken> appleIdToken() async {
  if (!firebaseReady) throw const FirebaseUnavailable();
  final rawNonce = _newNonce();
  final AuthorizationCredentialAppleID appleCred;
  try {
    appleCred = await SignInWithApple.getAppleIDCredential(
      scopes: const [
        AppleIDAuthorizationScopes.email,
        AppleIDAuthorizationScopes.fullName,
      ],
      nonce: sha256.convert(utf8.encode(rawNonce)).toString(),
    );
  } on SignInWithAppleAuthorizationException catch (e) {
    if (e.code == AuthorizationErrorCode.canceled) {
      throw const SocialSignInCancelled();
    }
    rethrow;
  }

  // **التوكن الغائب يُرفض هنا لا لدى Firebase.** آبل قد تُعيد اعتماداً بلا
  // `identityToken` (إعداد ناقص على معرّف التطبيق، أو جلسة iCloud غير
  // مكتملة)، وتمريره فارغاً يُنتج `invalid-credential` عاماً لا يدلّ على
  // موضعه — فيُبحث عن العطل في Firebase وهو في آبل.
  if (appleCred.identityToken == null) {
    throw Exception(
      'آبل لم تُعِد رمز هوية — تأكّد من تفعيل «تسجيل الدخول بحساب Apple» '
      'على معرّف التطبيق ومن تسجيل الدخول إلى iCloud على الجهاز',
    );
  }

  // **يُمرَّر رمز التفويض مع رمز الهوية.** بعض تركيبات Firebase/آبل ترفض
  // اعتماداً مبنيّاً على `idToken` وحده وتردّ `invalid-credential` بلا بيان.
  final cred = fb.OAuthProvider('apple.com').credential(
    idToken: appleCred.identityToken,
    rawNonce: rawNonce,
    accessToken: appleCred.authorizationCode,
  );

  final fb.UserCredential result;
  try {
    result = await fb.FirebaseAuth.instance.signInWithCredential(cred);
  } on fb.FirebaseAuthException catch (e) {
    // رسالة Firebase وحدها لا تدلّ على موضع العطل — نُلحق بها ما يميّزه.
    throw Exception(
      'فشل الدخول بآبل [${e.code}] ${e.message ?? ''} '
      '(هوية: ${appleCred.identityToken == null ? 'غائب' : 'موجود'}، '
      'تفويض: ${appleCred.authorizationCode.isEmpty ? 'غائب' : 'موجود'})',
    );
  }

  // **الاسم يصل مرة واحدة فقط**: آبل ترسله في أول دخول للحساب على هذا التطبيق
  // ولا ترسله بعدها أبداً. نثبّته على حساب Firebase ثم نُحدّث التوكن ليحمله،
  // وإلا وصل الخادمَ توكنٌ بلا اسم رغم أن آبل أرسلته للتوّ.
  final given = appleCred.givenName?.trim() ?? '';
  final family = appleCred.familyName?.trim() ?? '';
  final fullName = [given, family].where((p) => p.isNotEmpty).join(' ');
  if (fullName.isNotEmpty && result.user?.displayName == null) {
    try {
      await result.user?.updateDisplayName(fullName);
    } catch (_) {}
  }

  final idToken = await result.user?.getIdToken(true); // true = إجبار التحديث
  if (idToken == null) {
    throw Exception('تعذّر إتمام الدخول بآبل — أعد المحاولة');
  }
  return SocialIdToken('/auth/apple-login', idToken);
}

/// nonce عشوائي لمسار آبل — من `Random.secure` لا `Random()`: قيمة يمكن
/// التنبّؤ بها تُبطل الغرض منها.
String _newNonce([int length = 32]) {
  const charset =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._';
  final random = Random.secure();
  return List.generate(length, (_) => charset[random.nextInt(charset.length)])
      .join();
}
