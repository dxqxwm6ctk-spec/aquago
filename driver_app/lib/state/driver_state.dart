import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/offer_alert.dart';
import '../core/push_service.dart';
import '../core/location_broadcast.dart';
import '../core/social_auth.dart';

/// شاشات تطبيق السائق الأربع — تقابل مفتاح `screen` في التصميم الأصلي.
enum DriverScreen { shift, detail, run, earn }

/// مرحلة واحدة من مراحل تتبّع التسليم الأربع.
class DeliveryStage {
  const DeliveryStage({required this.label, required this.time});
  final String label;
  final String time;
}

/// حالة تطبيق السائق بالكامل — تقابل `state` و`renderVals()` في
/// `Aqua Go Driver.dc.html`. كائن واحد يمسك كل شيء وينادي
/// `notifyListeners()`، بلا طبقات repository/usecase (SKILL.md).
///
/// القيم الافتراضية والحدود (clamp) منسوخة حرفيًا عن التصميم الأصلي.
/// هذه مرحلة mock محلية بلا خادم — لما يُربط بالـAPI الفعلي، هذا الملف
/// هو ما يستبدل قيمه الثابتة باستدعاءات `core/api.dart`.
class DriverState extends ChangeNotifier {
  DriverState({ApiClient? api}) : api = api ?? ApiClient();

  /// عميل الخادم — يمسك التوكنين ويجدّدهما، وهو نفسه الذي تستعمله
  /// `PushService` لتسجيل توكن الجهاز.
  final ApiClient api;

  DriverScreen screen = DriverScreen.shift;
  bool online = true;

  /// بثّ موقع السائق — يتبع مفتاح الوردية.
  ///
  /// مملوك للحالة لا للشاشة: تدفّق الموقع يُبقي GPS يعمل، وبثٌّ يبدأ في
  /// `build` كان سيتكرّر مع كل إعادة رسم — أو يبقى بعد مغادرة الشاشة
  /// فيستنزف بطارية السائق طوال الوردية.
  ///
  /// تغيّرُ حالتها يُعاد بثّه من هنا (`notifyListeners`): الشاشات تستمع
  /// لـ`DriverState` وحدها، فحالةٌ تتغيّر داخل الخدمة (وصول موقع، انقطاع،
  /// رفض إذن) كانت تبقى غير مرئية — والسائق يقرأ «موقعك يصل» وهو لا يصل.
  late final LocationBroadcast location = LocationBroadcast(api)
    ..addListener(notifyListeners);
  int step = 1; // مرحلة التسليم الحالية 0..3 — تُضبط 1 عند بدء التوصيل
  int empties = 2; // قوارير فارغة مسترجعة، محصورة 0..12

  // ───────────────────────── الجلسة ─────────────────────────

  /// المستخدم كما يصفه الخادم (`publicUser`).
  Map<String, dynamic>? user;

  /// جارٍ إقلاع الجلسة من القرص.
  bool bootstrapping = true;

  /// آخر خطأ دخول ليُعرض في شاشة الدخول.
  String? authError;

  /// جارٍ تنفيذ دخول اجتماعي — يعطّل الأزرار فلا يُفتح مساران معاً.
  bool signingIn = false;

  bool get isLoggedIn => api.isLoggedIn && user != null;

  /// **السائق يعمل على جهاز واحد في المرة** (`enforceSingleDevice` على
  /// الخادم): الدخول من جهاز ثانٍ يطرد الأول بـ`NEW_DEVICE`، والمطرود يرى
  /// السبب في شاشة الدخول لا رسالة «جلسة غير صالحة» عامة.
  ///
  /// وهذا ما يجعل [ApiClient.onSessionEnded] هنا أثقل معنى منه في تطبيق
  /// الزبون: السائق قد يجد نفسه خارجاً وهو في منتصف توصيلة.
  String get driverName => (user?['name'] as String?)?.trim().isNotEmpty == true
      ? user!['name'] as String
      : 'سائق AquaGo';

  /// يُنادى مرة عند إقلاع التطبيق: يقرأ التوكنين من القرص ويجلب السائق.
  Future<void> bootstrap() async {
    api.onSessionEnded = _onSessionEnded;
    await api.loadTokens();
    if (api.isLoggedIn) {
      try {
        user = Map<String, dynamic>.from(await api.get('/auth/me'));
      } catch (e) {
        debugPrint('[auth] تعذّر جلب الحساب عند الإقلاع: $e');
      }
    }
    bootstrapping = false;
    // بعد استعادة الجلسة لا قبلها: `online` تبدأ `true`، فبثٌّ يبدأ مع
    // بناء الحالة كان سيسبق التوكن ويفشل بلا سبب ظاهر.
    _syncBroadcast();
    notifyListeners();
  }

  /// نفس معالج انتهاء الجلسة — مكشوف للاختبار.
  ///
  /// المسار الحقيقي يمرّ بـ`ApiClient` عند 401 أو سحب الجلسة؛ استدعاؤه في
  /// الاختبار عبر `logout()` كان يعني رحلةَ شبكةٍ لا ترجع.
  @visibleForTesting
  void onSessionEndedForTest() => _onSessionEnded();

  void _onSessionEnded() {
    user = null;
    unreadNotifications = 0;
    // الوردية تُغلق محلياً مع الجلسة: سائقٌ «متصل» في الواجهة بلا جلسة لا
    // تصله عروض، والشاشة تكذب عليه.
    online = false;
    unawaited(location.stop());
    notifyListeners();
  }

  Future<void> loginWithGoogle() => _social(googleIdToken);

  Future<void> loginWithApple() => _social(appleIdToken);

  Future<void> _social(Future<SocialIdToken> Function() provider) async {
    if (signingIn) return;
    signingIn = true;
    authError = null;
    notifyListeners();
    try {
      final result = await provider();
      final res = await api.post(result.path, {'idToken': result.idToken});
      await api.saveTokens(
        res['accessToken'] as String,
        res['refreshToken'] as String,
      );
      user = Map<String, dynamic>.from(res['user'] as Map);
      unawaited(PushService.instance.init(api));
      unawaited(refreshUnreadNotifications(api));
    } on SocialSignInCancelled {
      // إلغاءٌ مقصود — لا رسالة خطأ.
    } on ApiException catch (e) {
      authError = e.message;
    } catch (e) {
      authError = 'تعذّر إتمام الدخول — أعد المحاولة';
      debugPrint('[auth] فشل الدخول: $e');
    } finally {
      signingIn = false;
      notifyListeners();
    }
  }

  /// تسجيل الخروج — يُسحب توكن الجهاز أولاً، وإلا وصلت عروضُ الطلبات إلى
  /// جهاز خرج منه صاحبه.
  Future<void> logout() async {
    try {
      await PushService.instance.unregister(api);
    } catch (_) {}
    await api.clearTokens();
    _onSessionEnded();
  }

  /// رقم اللوحة مُحاط بعلامتَي LRI/PDI (U+2066/U+2069) لأن مقاطعه
  /// تُقلَب داخل سياق RTL فيظهر "2718-43" بدل "43-2718". تُكتب هروبًا
  /// لا حرفيًا، وإلا حذّر المحلّل من محارف اتجاه غير مرئية في الكود.
  static const String driverPlate = 'بيك أب \u{2066}43-2718\u{2069} · عمّان';

  // إحصائيات اليوم — بيانات وهمية ثابتة كما في التصميم الأصلي.
  static const String ordersToday = '11';
  static const String earningsToday = '18.750';
  static const String rating = '4.9';

  // بيانات الطلب الحالي (mock) — طلب واحد فقط في هذا العرض التصميمي.
  static const String orderId = 'AQ-1042';
  static const String orderDistance = '2.1 كم';
  static const String orderItems = 'قارورة 18.9 لتر × 2';
  static const String orderAddress = 'خلدا · شارع وصفي التل، بناية 24';
  static const String cashToCollect = '5.250';
  static const String customerName = 'الحسن';
  static const String customerNote =
      'الرجاء الاتصال عند الوصول، الدرج على اليمين.';
  static const String etaText = '2.1 كم · 9 دقائق';

  static const List<DeliveryStage> stages = [
    DeliveryStage(label: 'تم قبول الطلب', time: '8:04 ص'),
    DeliveryStage(label: 'تحميل القوارير من المركبة', time: '8:09 ص'),
    DeliveryStage(label: 'وصلت إلى العنوان', time: 'متوقّع 8:31 ص'),
    DeliveryStage(label: 'تم التسليم والتحصيل', time: '—'),
  ];

  // الأرباح
  static const String weeklyEarnings = '96.500';
  static const List<double> weeklyBars = [
    0.38,
    0.56,
    0.44,
    0.72,
    0.60,
    0.88,
    0.30,
  ];
  static const String completedOrders = '58';
  static const String cashToRemit = '42.000';

  static const List<(String id, String place, String time, String status, String amount)>
  history = [
    ('AQ-1039', 'تلاع العلي · 8:05 ص', '', 'مسلّم', '1.250'),
    ('AQ-1036', 'الرابية · 7:42 ص', '', 'مسلّم', '1.500'),
    ('AQ-1030', 'صويلح · 7:15 ص', '', 'ملغي', '0.000'),
  ];

  /// عدد الإشعارات غير المقروءة — يغذّي الشارة على أيقونة التطبيق.
  int unreadNotifications = 0;

  /// يجلب عدّاد غير المقروء ويزامن شارة الأيقونة معه
  /// (docs/NOTIFICATIONS_GUIDE.md §11).
  ///
  /// يُستدعى عند الإقلاع، والعودة من الخلفية، وبعد قراءة إشعار، وعند
  /// الخروج. الشارة ليست سبباً لإفشال أي شيء، فالفشل يُبتلع صامتاً.
  Future<void> refreshUnreadNotifications(ApiClient api) async {
    if (!api.isAuthenticated) {
      unreadNotifications = 0;
      notifyListeners();
      unawaited(PushService.instance.setBadge(0));
      return;
    }
    try {
      final res = await api.get('/notifications/unread-count');
      unreadNotifications = (res['unread'] as num?)?.toInt() ?? 0;
      notifyListeners();
      unawaited(PushService.instance.setBadge(unreadNotifications));
    } catch (_) {
      // لا شيء: عدّاد قديم أهون من شاشة خطأ لأجل شارة.
    }
  }

  void setScreen(DriverScreen s) {
    if (screen == s) return;
    screen = s;
    notifyListeners();
  }

  @override
  void dispose() {
    location
      ..removeListener(notifyListeners)
      ..dispose();
    super.dispose();
  }

  /// تبديل الوردية (متصل/غير متصل) — تبديل بسيط بلا تأكيد، كما في
  /// التصميم الأصلي.
  void toggleOnline() {
    online = !online;
    _syncBroadcast();
    notifyListeners();
  }

  /// يبدأ البثّ مع الوردية ويوقفه معها.
  ///
  /// الشرطان معاً — وردية مفتوحة **وجلسة قائمة**: القناة تحمل التوكن في
  /// مصافحتها، فبثٌّ بلا جلسة يدور في حلقة إعادة وصلٍ لا تنتهي.
  void _syncBroadcast() {
    if (online && isLoggedIn) {
      unawaited(location.start());
    } else {
      unawaited(location.stop());
    }
  }

  /// قبول العرض الظاهر في شاشة الوردية: ينتقل لتفاصيل الطلب مباشرة —
  /// لا حالة "عرض معلَّق" وسيطة في هذا العرض التصميمي.
  ///
  /// وتُسكت النغمة المتكررة أولاً: العرض لم يعد بانتظار ردّ، فبقاؤها
  /// يرنّ بعد القبول (§9.2).
  void acceptOffer() {
    unawaited(OfferAlert.instance.stop());
    setScreen(DriverScreen.detail);
  }

  /// بدء التوصيل من شاشة تفاصيل الطلب: ينتقل لشاشة التوصيل الجاري
  /// ويصفّر عدّاد المراحل إلى 1.
  void startDelivery() {
    screen = DriverScreen.run;
    step = 1;
    notifyListeners();
  }

  void decEmpties() {
    empties = (empties - 1).clamp(0, 12);
    notifyListeners();
  }

  void incEmpties() {
    empties = (empties + 1).clamp(0, 12);
    notifyListeners();
  }

  /// زرّ الـCTA بشاشة التوصيل الجاري: يتقدّم للمرحلة التالية، وعند آخر
  /// مرحلة (3) ينهي الطلب وينتقل لشاشة الأرباح.
  void advanceOrFinish() {
    if (step < 3) {
      step = (step + 1).clamp(0, 3);
    } else {
      screen = DriverScreen.earn;
    }
    notifyListeners();
  }

  bool get isLastStep => step >= 3;
}
