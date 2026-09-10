# ما تبقّى لتشغيل الدخول — إعداد لا يُكتب في الكود

طبقة الدخول في التطبيقين جاهزة (`api_client.dart`, `social_auth.dart`,
`auth_gate.dart`). ما يلي إعدادُ كونسول ومشاريع أصيلة لا يُنجَز من المستودع،
وبدونه يفشل زرّ الدخول عند أول ضغطة.

المرجع الكامل للمعمار: `stitch_jordan_gas_delivery_system/docs/AUTH_GUIDE.md`.

## 1. تفعيل مزوّدي الدخول في Firebase

مشروع `aqua-go-7cdd9` → Authentication → Sign-in method:

- **Google**: فعّله. هذا وحده يملأ `oauth_client` في ملفات الإعداد.
- **Apple**: فعّله (Service ID وTeam ID ومفتاح `.p8` من حساب المطوّر).

> **الحالة الآن**: `google-services.json` و`GoogleService-Info.plist` في
> التطبيقين يحملان `"oauth_client": []` فارغة ولا يحملان `CLIENT_ID` ولا
> `REVERSED_CLIENT_ID` — دليلٌ قاطع أن Google Sign-In غير مفعّل بعد. بعد
> تفعيله **أعد تنزيل الملفين لكل تطبيق** واستبدل الموجودَين؛ الملف القديم لا
> يكتسب المفاتيح بنفسه.

معرّفات الحزم الأربعة: `jo.aquago.customer` و`jo.aquago.driver` (أندرويد
وiOS لكلٍّ منهما).

## 2. أندرويد — بصمة SHA-1

دخول جوجل على أندرويد يرفض أي تطبيق لم تُسجَّل بصمته:

```bash
# بصمة التطوير
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```

تُضاف في Firebase → Project settings → التطبيق → Add fingerprint. وتُضاف
معها بصمة مفتاح الإصدار، **وبصمة Play App Signing** إن كان النشر عبر Play
(بصمة الرفع وحدها لا تكفي، والدخول ينجح في الاختبار ويفشل بعد النشر).

## 3. iOS — أمران في Xcode

### أ. مخطط العودة لجوجل

من `GoogleService-Info.plist` الجديد خذ `REVERSED_CLIENT_ID` وأضفه في
`ios/Runner/Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.googleusercontent.apps.276428851477-XXXXXXXX</string>
    </array>
  </dict>
</array>
```

بدونه يفتح المتصفح ولا يعود إلى التطبيق أبداً.

### ب. ربط ملف الصلاحيات

`ios/Runner/Runner.entitlements` **مكتوب في المستودع** ويحمل
`com.apple.developer.applesignin`، لكنه غير مربوط بالهدف: لا
`CODE_SIGN_ENTITLEMENTS` في `project.pbxproj`. يُربط من Xcode لا يدوياً
(ملفّا التوقيع يجري تعديلهما الآن في فرع آخر، والتحرير اليدوي يصطدم به):

> Runner target → Signing & Capabilities → **+ Capability** → Sign in with
> Apple. يربط Xcode الملف ويحدّث `project.pbxproj` بنفسه.

ويجب تفعيل القدرة نفسها على معرّف التطبيق في حساب المطوّر.

> آبل تشترط «تسجيل الدخول بحساب Apple» على كل تطبيق يعرض دخولاً بمزوّد خارجي
> (Guideline 4.8) — غيابه رفضٌ عند المراجعة لا تحذير.

## 4. عنوان الخادم

الافتراضي `http://10.0.2.2:3000` (مضيف الجهاز من محاكي أندرويد). للجهاز
الحقيقي والإصدار:

```bash
flutter run --dart-define=AQUAGO_API_BASE=https://api.aquago.jo
```

## 5. فحص سريع بعد الإعداد

- [ ] الدخول بجوجل يُعيد `accessToken` و`refreshToken` و`user`
- [ ] إغلاق التطبيق وفتحه يُبقي الجلسة (لا شاشة دخول)
- [ ] الدخول بحساب السائق من جهاز ثانٍ يُخرج الأول **برسالة سببه**
      (`NEW_DEVICE`) لا بـ«جلسة غير صالحة»
- [ ] إسقاط الخادم (500) لا يطرد أحداً — الجلسة تبقى للمحاولة التالية
- [ ] «تسجيل الخروج» يُلغي الجلسة على الخادم لا محلياً وحده
- [ ] شاشة «الأجهزة» في اللوحة تُظهر الجهاز باسمه لا `Dart/3.x (dart:io)`
