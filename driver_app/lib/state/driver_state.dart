import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/driver_models.dart';
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

  // ───────────────────── بيانات الخادم ─────────────────────

  /// العرض المعلّق الحالي — `null` حين لا عرض.
  DriverOffer? offer;

  /// الطلب المفتوح على السائق الآن.
  DriverOrder? currentOrder;

  /// إحصائيات السائق (توصيلات وتقييم — لا أرباح، انظر [DriverStats]).
  DriverStats? stats;

  /// سجلّ الطلبات — آخر خمسين.
  List<DriverOrder> orders = const [];

  bool loadingData = false;
  String? dataError;

  /// جارٍ قبول عرض أو تحديث حالة — يمنع ضغطتين متتاليتين.
  bool busy = false;

  /// سبب رفض آخر إجراء كما يقوله الخادم.
  String? actionError;

  /// **يحمّل ما تعرضه شاشات السائق.**
  ///
  /// الثلاثة معاً: العرض والإحصائيات والطلبات تُعرض في نفس اللحظة، وتسلسلها
  /// كان يضاعف الانتظار على شبكة الهاتف بلا سبب.
  Future<void> loadDriverData() async {
    if (!api.isAuthenticated || loadingData) return;
    loadingData = true;
    dataError = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        api.get('/driver/offers/current'),
        api.get('/driver/stats'),
        api.getList('/driver/orders'),
      ]);

      final offerJson = (results[0] as Map<String, dynamic>)['offer'];
      offer = offerJson is Map
          ? DriverOffer.fromJson(Map<String, dynamic>.from(offerJson))
          : null;

      stats = DriverStats.fromJson(results[1] as Map<String, dynamic>);

      orders = (results[2] as List<Map<String, dynamic>>)
          .map(DriverOrder.fromJson)
          .toList(growable: false);
      // الطلب المفتوح يُشتقّ من السجلّ لا يُطلب على حدة: `/driver/orders`
      // يردّه ضمنها مرتَّباً، ونداءٌ ثانٍ لأجله رحلةٌ بلا زيادة معرفة.
      currentOrder = orders.where((o) => o.isActive).firstOrNull;
    } on ApiException catch (e) {
      dataError = e.message;
    } catch (e) {
      dataError = 'تعذّر تحميل بياناتك — تحقّق من اتصالك';
      debugPrint('[driver] $e');
    } finally {
      loadingData = false;
      notifyListeners();
    }
  }

  /// **قبول العرض.**
  ///
  /// الخادم يحمي القبول ذرّياً: عرضان لطلبٍ واحد لا يُقبلان معاً، والخاسر
  /// يُردّ برسالة. عرضُ رسالته أصدق من ابتلاعها وترك السائق ينتظر طلباً أخذه
  /// غيره.
  Future<void> acceptOffer() async {
    final id = offer?.id;
    if (id == null || busy) return;
    busy = true;
    actionError = null;
    notifyListeners();
    // النغمة تُسكت أولاً: العرض لم يعد بانتظار ردّ، وبقاؤها ترنّ بعد
    // القبول (§9.2).
    unawaited(OfferAlert.instance.stop());
    try {
      await api.post('/driver/offers/$id/accept', const {});
      offer = null;
      screen = DriverScreen.detail;
      await loadDriverData();
    } on ApiException catch (e) {
      actionError = e.message;
      // العرض انتهى أو أخذه غيره — تُنظَّف الشاشة بقراءةٍ جديدة بدل إبقاء
      // بطاقةٍ لعرضٍ لم يعد قائماً.
      await loadDriverData();
    } catch (e) {
      actionError = 'تعذّر قبول العرض — تحقّق من اتصالك';
      debugPrint('[driver] $e');
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> rejectOffer() async {
    final id = offer?.id;
    if (id == null || busy) return;
    busy = true;
    notifyListeners();
    try {
      unawaited(OfferAlert.instance.stop());
      await api.post('/driver/offers/$id/reject', const {});
      offer = null;
    } catch (e) {
      debugPrint('[driver] رفض العرض: $e');
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  /// **تقدّم التوصيل** — الحالة التالية يفرضها الخادم لا ضغطةٌ محلية.
  ///
  /// كانت المراحل تتقدّم بضغطةٍ في التطبيق وحده: يرى السائق «تم التسليم»
  /// وحالةُ الطلب على الخادم لم تتغيّر، والزبون ينتظر شاحنةً وصلت.
  Future<void> advanceOrder() async {
    final order = currentOrder;
    final next = order?.nextStatus;
    if (order == null || next == null || busy) return;
    busy = true;
    actionError = null;
    notifyListeners();
    try {
      await api.post('/driver/orders/${order.id}/status', {'status': next});
      await loadDriverData();
      // الطلب اكتمل ⇐ لا شاشة توصيلٍ بعده.
      if (currentOrder == null) screen = DriverScreen.shift;
    } on ApiException catch (e) {
      actionError = e.message;
    } catch (e) {
      actionError = 'تعذّر تحديث الحالة — تحقّق من اتصالك';
      debugPrint('[driver] $e');
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  /// يبلّغ الخادم بالوصول إلى باب الزبون — لا ينقل الحالة.
  Future<void> reportArrived() async {
    final order = currentOrder;
    if (order == null) return;
    try {
      final p = location.lastSent;
      await api.post('/driver/orders/${order.id}/arrived', {
        if (p != null) 'lat': p.latitude,
        if (p != null) 'lng': p.longitude,
      });
    } catch (e) {
      // خبرٌ لا حالة: فشلُه لا يمنع السائق من إتمام التسليم.
      debugPrint('[driver] تعذّر تبليغ الوصول: $e');
    }
  }

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
    // العرض المعلّق يُقرأ عند الإقلاع: عرضٌ وصل والتطبيق مغلق كان يضيع —
    // الـSocket لا يُسلّم ما فات، والمؤقّت يمضي على السائق وهو لا يدري.
    unawaited(loadDriverData());
  }

  /// يضع طلباً مفتوحاً وعرضاً بلا رحلة شبكة — للاختبار وحده.
  ///
  /// شاشات السائق صارت تقرأ من الخادم، فاختبارُ عرضها كان يحتاج خادماً
  /// ليقيس واجهةً لا شبكة فيها.
  @visibleForTesting
  void setDataForTest({
    DriverOrder? order,
    DriverOffer? pendingOffer,
    DriverStats? driverStats,
    List<DriverOrder>? history,
  }) {
    currentOrder = order;
    offer = pendingOffer;
    stats = driverStats;
    if (history != null) orders = history;
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
      unawaited(loadDriverData());
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

  static const List<DeliveryStage> stages = [
    DeliveryStage(label: 'تم قبول الطلب', time: '8:04 ص'),
    DeliveryStage(label: 'تحميل القوارير من المركبة', time: '8:09 ص'),
    DeliveryStage(label: 'وصلت إلى العنوان', time: 'متوقّع 8:31 ص'),
    DeliveryStage(label: 'تم التسليم والتحصيل', time: '—'),
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
    // **الخادم يعرف بالوردية.** كان التبديل محلياً وحده: سائقٌ «غير متصل»
    // في شاشته يبقى `AVAILABLE` على الخادم فتصله العروض، وسائقٌ فتح ورديته
    // لا تصله لأن حالته لم تتغيّر هناك.
    unawaited(_pushStatus());
  }

  Future<void> _pushStatus() async {
    if (!api.isAuthenticated) return;
    try {
      await api.patch('/driver/status', {
        'status': online ? 'AVAILABLE' : 'OFFLINE',
      });
      if (online) await loadDriverData();
    } catch (e) {
      debugPrint('[driver] تعذّر تحديث حالة الوردية: $e');
    }
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

  /// بدء التوصيل: ينقل حالة الطلب على الخادم ثم يفتح شاشة التوصيل.
  ///
  /// كان ينقل الشاشة ويصفّر عدّاداً محلياً بلا أن يعرف الخادم شيئاً — فيبقى
  /// الطلب `DRIVER_ASSIGNED` بينما السائق يظنّ أنه بدأ، والزبون يرى مرحلةً
  /// لم تتقدّم.
  Future<void> startDelivery() async {
    await advanceOrder();
    if (currentOrder != null) {
      screen = DriverScreen.run;
      notifyListeners();
    }
  }

  void decEmpties() {
    empties = (empties - 1).clamp(0, 12);
    notifyListeners();
  }

  void incEmpties() {
    empties = (empties + 1).clamp(0, 12);
    notifyListeners();
  }

  bool get isLastStep => step >= 3;
}
