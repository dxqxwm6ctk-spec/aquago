import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/catalog.dart';
import '../core/push_service.dart';
import '../core/social_auth.dart';
import '../core/tracking_service.dart';

/// شاشات تطبيق الزبون السبع — تقابل مفتاح `screen` في التصميم الأصلي.
enum AppScreen { home, order, checkout, track, orders, wallet, account }

/// وقت التوصيل المختار في شاشة الدفع.
enum DeliveryWhen { now, later }

/// طلبٌ جارٍ — يغيب حين لا يكون للزبون طلب.
///
/// كان أربعة ثوابت `static const` تُقرأ مباشرة، فبطاقة «طلبك في الطريق»
/// تظهر لكل زبون دائماً — بمن فيهم من لم يطلب قطّ، ومن سلّمه السائق للتوّ.
/// كائنٌ قابل لأن يكون `null` يجعل الغياب حالةً تُمثَّل لا حالةً تُنسى.
@immutable
class ActiveOrder {
  const ActiveOrder({
    required this.id,
    required this.items,
    required this.eta,
    required this.progress,
    this.serverId,
  });

  /// الرقم الذي يراه الزبون ويذكره عند الاتصال (`code`).
  final String id;

  /// معرّف الطلب على الخادم — به يُشترك في غرفة التتبّع.
  ///
  /// غير `id`: الغرفة تُبنى بمعرّفٍ داخلي (`order:{id}`)، والاشتراك بالرقم
  /// المعروض كان يُرفض من الخادم فلا يصل موقعٌ واحد.
  final String? serverId;
  final String items;
  final String eta;

  /// من 0 إلى 1 — نسبة اكتمال الطلب في شريط التقدّم.
  ///
  /// يُشتقّ من مرحلة التتبّع لا يُخزَّن مستقلاً: رقمٌ ثابت (0.68) كان يبقى
  /// كما هو بينما تتقدّم المراحل في شاشة التتبّع، فيتناقض الشريطان في
  /// شاشتين عن الطلب نفسه.
  final double progress;
}

/// مرحلة واحدة من مراحل تتبّع الطلب الأربع.
class TrackStage {
  const TrackStage({required this.label, required this.time});
  final String label;
  final String time;
}

/// حالة تطبيق الزبون بالكامل — تقابل `state` و`renderVals()` في
/// `Aqua Go.dc.html`. كائن واحد يمسك كل شيء وينادي `notifyListeners()`،
/// بلا طبقات repository/usecase (SKILL.md).
///
/// القيم الافتراضية والحدود (clamp) والمعادلات (السعر الإجمالي) منسوخة
/// حرفيًا عن التصميم الأصلي. هذه مرحلة mock محلية بلا خادم — لما يُربط
/// بالـAPI الفعلي، هذا الملف هو ما يستبدل بياناته الثابتة باستدعاءات
/// `core/api.dart`.
class AppState extends ChangeNotifier {
  AppState({ApiClient? api}) : api = api ?? ApiClient();

  /// عميل الخادم — يمسك التوكنين ويجدّدهما، وهو نفسه الذي تستعمله
  /// `PushService` لتسجيل توكن الجهاز.
  final ApiClient api;

  AppScreen screen = AppScreen.home;
  int product = 0;
  int qty = 2; // محصور 1..9
  DeliveryWhen when = DeliveryWhen.now;
  int step = 2; // مرحلة تتبّع الطلب الحالية 0..3

  // ───────────────────────── الجلسة ─────────────────────────

  /// المستخدم كما يصفه الخادم (`publicUser`) — لا نُشتقّ منه شيئاً محلياً:
  /// البوابات الثلاث أدناه يقرّرها الخادم وحده.
  Map<String, dynamic>? user;

  /// جارٍ إقلاع الجلسة من القرص — الشاشة تنتظره بدل أن تومض شاشةَ دخول
  /// لمن هو داخلٌ أصلاً.
  bool bootstrapping = true;

  /// آخر خطأ دخول ليُعرض في شاشة الدخول.
  String? authError;

  /// جارٍ تنفيذ دخول اجتماعي — يعطّل الأزرار فلا يُفتح مساران معاً.
  bool signingIn = false;

  bool get isLoggedIn => api.isLoggedIn && user != null;

  String get userName => (user?['name'] as String?)?.trim().isNotEmpty == true
      ? user!['name'] as String
      : 'زبون AquaGo';

  String get userPhone => (user?['phone'] as String?) ?? '';

  /// **البوابات الثلاث بعد الدخول — الخادم يقرّرها لا التطبيق.**
  ///
  /// الترتيب المقصود: الشروط ← تأكيد الاسم ← توثيق الهاتف (الأخيرة تُعرض
  /// قبل أول طلب لا عند الدخول).
  bool get mustAcceptTerms => isLoggedIn && user?['termsAccepted'] == false;
  bool get mustConfirmName => isLoggedIn && user?['nameConfirmed'] == false;
  bool get mustVerifyPhone => isLoggedIn && user?['phoneVerified'] == false;

  /// يُنادى مرة عند إقلاع التطبيق: يقرأ التوكنين من القرص ويجلب المستخدم.
  ///
  /// فشلُ `/auth/me` بعطل شبكة لا يُخرج الزبون — التوكن يبقى وتُعاد المحاولة
  /// لاحقاً. الإخراج قرارُ الخادم وحده عبر [ApiClient.onSessionEnded].
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
    notifyListeners();
    // الكتالوج بعد الجلسة لا قبلها: العناوين خلف الحارس، وتحميلها قبل
    // استعادة التوكن كان يردّ 401 فتبقى القائمة فارغة حتى إعادة التشغيل.
    // ولا يُنتظر: الشاشة تُبنى بحالة تحميل معلنة بدل بابٍ أبيض.
    unawaited(loadCatalog());
  }

  void _onSessionEnded() {
    user = null;
    unreadNotifications = 0;
    // القناة تحمل توكن الجلسة في مصافحتها — بلا إغلاقها تبقى تحاول الوصل
    // بتوكن مسحوب في حلقةِ إعادةِ وصلٍ لا تنتهي.
    unawaited(tracking.stop());
    notifyListeners();
  }

  /// دخول جوجل — المسار الأساسي.
  Future<void> loginWithGoogle() => _social(googleIdToken);

  /// دخول آبل — على iOS وحده ([appleSignInAvailable]).
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
      // توكن الجهاز يُسجَّل الآن لا قبله: مسار `/device-tokens` خلف الحارس.
      unawaited(PushService.instance.init(api));
      unawaited(refreshUnreadNotifications(api));
      // عناوين الزبون تخصّه: من دخل الآن كان الكتالوج قد حُمّل بلا عناوين.
      unawaited(loadCatalog());
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

  /// تسجيل الخروج — يُبلَّغ الخادم ليُلغي الجلسة، ويُسحب توكن الجهاز أولاً
  /// وإلا وصلت إشعارات الحساب إلى جهاز خرج منه صاحبه.
  Future<void> logout() async {
    try {
      await PushService.instance.unregister(api);
    } catch (_) {}
    await api.clearTokens();
    _onSessionEnded();
  }

  /// قبول الشروط، ثم تأكيد الاسم — البوابتان تُحدّثان المستخدم من ردّ الخادم
  /// نفسه، فتُغلقان بقراره لا بافتراض التطبيق.
  Future<void> acceptTerms() async {
    final res = await api.post('/auth/me/accept-terms', const {});
    _applyUser(res);
  }

  Future<void> confirmName(String name) async {
    final res = await api.post('/auth/me/confirm-name', {'name': name});
    _applyUser(res);
  }

  void _applyUser(Map<String, dynamic> res) {
    final payload = res['user'] ?? res;
    if (payload is Map) user = Map<String, dynamic>.from(payload);
    notifyListeners();
  }

  static const double deliveryFee = 0.25;
  static const double firstOrderDiscount = -0.25;

  static const List<TrackStage> trackStages = [
    TrackStage(label: 'تم تأكيد الطلب', time: '8:02 ص'),
    TrackStage(label: 'جاري تجهيز مياهك', time: '8:09 ص'),
    TrackStage(label: 'في الطريق إليك', time: '8:21 ص'),
    TrackStage(label: 'تم التسليم', time: 'متوقّع 8:33 ص'),
  ];

  /// قناة التتبّع الحيّ — تُفتح على شاشة التتبّع وتُغلق عند مغادرتها.
  ///
  /// مملوكة للحالة لا للشاشة: بناءُ الشاشة يتكرّر مع كل إعادة رسم، وقناةٌ
  /// تُفتح هناك كانت ستُفتح وتُغلق مرات بلا سبب — أو تبقى مفتوحة بعد
  /// مغادرتها فتستهلك بطارية وبيانات بلا مستفيد.
  ///
  /// تغيّرُ حالتها يُعاد بثّه من هنا (`notifyListeners`): الشاشات تستمع
  /// لـ`AppState` وحدها، فوصولُ موقعٍ جديد أو انقطاعُ القناة كان يبقى غير
  /// مرئي — والخريطة تتجمّد على أول موقع بلا كلمة.
  late final TrackingService tracking = TrackingService(api)
    ..addListener(notifyListeners);

  // ───────────────────── الكتالوج والعناوين ─────────────────────

  /// كتالوج القوارير من الخادم — فارغ حتى يصل.
  List<BottleType> bottleTypes = const [];

  /// عناوين الزبون من الخادم.
  List<Address> addresses = const [];

  /// جارٍ تحميل الكتالوج أو العناوين.
  bool loadingCatalog = false;

  /// سبب فشل التحميل — يُعرض بدل شاشة فارغة بلا تفسير.
  String? catalogError;

  /// العنوان المختار للطلب.
  Address? selectedAddress;

  /// جارٍ إرسال الطلب إلى الخادم.
  bool placingOrder = false;

  /// سبب رفض الطلب كما يقوله الخادم (سعر تغيّر، خارج التغطية، طلب نشط).
  String? orderError;

  /// المنتج المختار من الكتالوج — `null` قبل وصوله.
  BottleType? get selectedBottle =>
      product >= 0 && product < bottleTypes.length ? bottleTypes[product] : null;

  /// **يحمّل الكتالوج والعناوين معاً.**
  ///
  /// المسألتان تُطلبان في نفس اللحظة وتُعرضان في نفس الشاشة، وتسلسلهما كان
  /// يضاعف زمن الانتظار على شبكة الهاتف بلا سبب.
  Future<void> loadCatalog() async {
    if (loadingCatalog) return;
    loadingCatalog = true;
    catalogError = null;
    notifyListeners();
    try {
      // الكتالوج عام بلا دخول؛ العناوين خلف الحارس — فمن لم يدخل بعد يرى
      // المنتجات ولا يُحرم منها بانتظار جلسة.
      final results = await Future.wait([
        api.getList('/bottle-types'),
        if (api.isAuthenticated) api.getList('/addresses'),
      ]);
      bottleTypes = results.first
          .map((j) => BottleType.fromJson(j))
          .toList(growable: false);
      if (results.length > 1) {
        addresses =
            results[1].map((j) => Address.fromJson(j)).toList(growable: false);
        selectedAddress = _pickDefaultAddress();
      }
      // فهرس المنتج قد يتجاوز كتالوجاً أقصر — الحدّ هنا يمنع `RangeError`
      // في كل شاشة تقرأ `selectedBottle`.
      if (product >= bottleTypes.length) product = 0;
    } on ApiException catch (e) {
      catalogError = e.message;
    } catch (e) {
      catalogError = 'تعذّر تحميل المنتجات — تحقّق من اتصالك';
      debugPrint('[catalog] $e');
    } finally {
      loadingCatalog = false;
      notifyListeners();
    }
  }

  /// الافتراضي إن وُجد، وإلا أول عنوان مغطّى، وإلا الأول.
  ///
  /// التغطية تُراعى في الاختيار التلقائي: عنوانٌ خارجها يُرفض عند التأكيد،
  /// فاختيارُه للزبون يقوده إلى رفضٍ لم يفعل شيئاً ليستحقّه.
  Address? _pickDefaultAddress() {
    if (addresses.isEmpty) return null;
    for (final a in addresses) {
      if (a.isDefault && a.covered) return a;
    }
    for (final a in addresses) {
      if (a.covered) return a;
    }
    return addresses.first;
  }

  void selectAddress(Address a) {
    selectedAddress = a;
    notifyListeners();
  }

  /// جارٍ حفظ عنوان جديد.
  bool savingAddress = false;

  /// سبب رفض العنوان كما يقوله الخادم.
  String? addressError;

  /// **يضيف عنواناً ويختاره.**
  ///
  /// بلا هذا المسار لا يستطيع زبونٌ جديد أن يطلب إطلاقاً: `POST /orders`
  /// يشترط `addressId`، ولم يكن في التطبيق ما يُنشئ عنواناً — فالعناوين
  /// تُقرأ ولا تُكتب.
  ///
  /// يُعيد `true` عند النجاح لتغلق الشاشة بقرارٍ لا بافتراض.
  Future<bool> addAddress({
    required String label,
    required String street,
    required String building,
    required String floor,
    required double lat,
    required double lng,
    String? notes,
  }) async {
    if (savingAddress) return false;
    savingAddress = true;
    addressError = null;
    notifyListeners();
    try {
      final res = await api.post('/addresses', {
        'label': label,
        'street': street,
        // إلزاميان على الخادم — إرسالهما فارغَين يردّ 400 برسالة تحقّق
        // إنجليزية لا تعني الزبون شيئاً، فتُمنع الحالة من الشاشة نفسها.
        'building': building,
        'floor': floor,
        if (notes?.trim().isNotEmpty == true) 'notes': notes!.trim(),
        'lat': lat,
        'lng': lng,
      });
      final created = Address.fromJson(res);
      addresses = [...addresses, created];
      selectedAddress = created;
      return true;
    } on ApiException catch (e) {
      addressError = e.message;
      return false;
    } catch (e) {
      addressError = 'تعذّر حفظ العنوان — تحقّق من اتصالك';
      debugPrint('[address] $e');
      return false;
    } finally {
      savingAddress = false;
      notifyListeners();
    }
  }

  /// الطلب الجاري — `null` حين لا طلب، فلا تُعرض بطاقته أصلاً.
  ///
  /// يُملأ عند تأكيد الطلب من شاشة الدفع (`confirmOrder`) لا قبله.
  ActiveOrder? activeOrder;

  /// عدد الإشعارات غير المقروءة — يغذّي الشارة على أيقونة التطبيق
  /// والنقطة الحمراء في الواجهة.
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

  @override
  void dispose() {
    tracking
      ..removeListener(notifyListeners)
      ..dispose();
    super.dispose();
  }

  /// السعر من الكتالوج — صفر قبل وصوله، فلا شاشة تعرض رقماً مخترعاً.
  double get subtotal => (selectedBottle?.price ?? 0) * qty;
  double get total => subtotal + deliveryFee + firstOrderDiscount;

  String fmt(double n) => n.toStringAsFixed(3);

  void setScreen(AppScreen s) {
    if (screen == s) return;
    screen = s;
    _syncTracking();
    notifyListeners();
  }

  /// يفتح قناة التتبّع على شاشة التتبّع وحدها، ويغلقها عند مغادرتها.
  ///
  /// الشرطان معاً: شاشةُ التتبّع **وطلبٌ قائم**. بلا الثاني كانت القناة
  /// تُفتح لتشترك في غرفة طلبٍ لا وجود له فيردّ الخادم بالرفض.
  void _syncTracking() {
    final order = activeOrder;
    final trackId = order?.serverId;
    if (screen == AppScreen.track && trackId != null) {
      unawaited(tracking.start(trackId));
    } else if (tracking.status != TrackingStatus.idle) {
      // الشرط على الحالة لا على `isTracking`: محاولةُ بدءٍ فشلت قبل فتح
      // القناة (بلا جلسة مثلاً) تترك حالةً معلنة و`isTracking` false — فكان
      // الإغلاق يتخطّاها وتبقى الشاشة تُعلن انقطاعاً بعد مغادرتها.
      unawaited(tracking.stop());
    }
  }

  void selectProduct(int index) {
    product = index;
    notifyListeners();
  }

  /// اختيار منتج من بطاقات الرئيسية ثم الانتقال إليه في شاشة الاختيار.
  ///
  /// خطوة واحدة لا خطوتان: البطاقات كانت عرضاً لا يُضغط، فمن أراد «18.9
  /// لتر» ضغطها بلا أثر ثم بحث عن طريق آخر — و`setScreen` وحدها كانت
  /// ستفتح الشاشة على منتجٍ آخر هو المختار سابقاً.
  void openProduct(int index) {
    product = index;
    screen = AppScreen.order;
    notifyListeners();
  }

  void decQty() {
    qty = (qty - 1).clamp(1, 9);
    notifyListeners();
  }

  void incQty() {
    qty = (qty + 1).clamp(1, 9);
    notifyListeners();
  }

  void pickWhen(DeliveryWhen w) {
    when = w;
    notifyListeners();
  }

  /// **تأكيد الطلب — إلى الخادم فعلاً.**
  ///
  /// كان الطلب يُخترع محلياً برقمٍ عشوائي ولا يغادر الجهاز: لا وكالة تعرف
  /// به، ولا سائق يصله، ولا شيء يُوصَّل. والزبون يرى شاشة تتبّعٍ كاملة.
  ///
  /// `expectedTotal` يُرسل عمداً: الخادم يحسب من أسعاره ويقارن، فيرفض طلباً
  /// بُني على سعرٍ تغيّر بعد أن فُتحت الشاشة — بدل أن يُخصم من الزبون غير ما
  /// رآه.
  Future<void> confirmOrder() async {
    if (placingOrder) return;
    final bottle = selectedBottle;
    final address = selectedAddress;
    if (bottle == null || address == null) {
      orderError = address == null
          ? 'أضف عنوان توصيل أولاً'
          : 'اختر منتجاً أولاً';
      notifyListeners();
      return;
    }

    placingOrder = true;
    orderError = null;
    notifyListeners();
    try {
      final res = await api.post('/orders', {
        'addressId': address.id,
        'items': [
          {'bottleTypeId': bottle.id, 'qty': qty},
        ],
        'expectedTotal': total,
      });
      final order = Order.fromJson(res);
      activeOrder = ActiveOrder(
        id: order.code,
        serverId: order.id,
        items: order.itemsLabel,
        eta: _etaText(order),
        progress: 0,
      );
      screen = AppScreen.track;
      // المرحلة من حالة الخادم لا من صفرٍ مفترض: الطلب يعود `CREATED` بحالته
      // الأولى، لكن التوزيع يجري في طابور وقد يسبق أول قراءة.
      step = order.stageIndex;
      _syncTracking();
    } on ApiException catch (e) {
      // رسائل الخادم عربية ومقصودة للزبون: «طلبك السابق ما زال جارياً»،
      // «العنوان خارج نطاق التغطية»، «تغيّر السعر». استبدالها بنصٍّ عام
      // يُخفي ما يستطيع الزبون تصحيحه بنفسه.
      orderError = e.message;
    } catch (e) {
      orderError = 'تعذّر إرسال الطلب — تحقّق من اتصالك';
      debugPrint('[order] $e');
    } finally {
      placingOrder = false;
      notifyListeners();
    }
  }

  /// يضبط العناوين بلا رحلة شبكة — للاختبار وحده.
  ///
  /// `state.addresses = …` إسنادٌ بلا `notifyListeners`، فالشاشة تبقى على
  /// القائمة القديمة ويبدو التغيير ضائعاً وهو واقع.
  @visibleForTesting
  void setAddressesForTest(List<Address> list, {Address? selected}) {
    addresses = list;
    selectedAddress = selected;
    notifyListeners();
  }

  /// يضع طلباً جارياً بلا رحلة شبكة — للاختبار وحده.
  ///
  /// `confirmOrder` صار يرحل إلى الخادم، فاختبارُ ما بعد الطلب (بطاقة
  /// الرئيسية، شاشة التتبّع) كان يحتاج خادماً ليقيس عرضاً لا شبكة فيه.
  @visibleForTesting
  void setActiveOrderForTest(ActiveOrder order, {int stage = 0}) {
    activeOrder = order;
    screen = AppScreen.track;
    step = stage;
    _syncTracking();
    notifyListeners();
  }

  static String _etaText(Order o) {
    final m = o.etaMinutes;
    if (m == null) return 'جارٍ تعيين سائق';
    return 'يصل خلال $m دقيقة';
  }

  /// شاشة التتبّع: الضغط في أي مكان بالبطاقة يقدّم المرحلة، وتدور
  /// بعد آخر مرحلة رجوعًا للأولى (محاكاة تقدّم الطلب في هذا العرض).
  void advanceTrackStep() {
    step = (step + 1) % trackStages.length;
    final order = activeOrder;
    if (order != null) {
      activeOrder = ActiveOrder(
        id: order.id,
        items: order.items,
        // آخر مرحلة = تم التسليم، فلا وقت وصول متبقّياً.
        eta: step == trackStages.length - 1 ? 'تم التسليم' : order.eta,
        progress: step / (trackStages.length - 1),
      );
    }
    notifyListeners();
  }

  /// نص الإجراء الأساسي (CTA) الحالي حسب الشاشة — يعيد null إن كانت
  /// الشاشة لا تعرض شريط CTA سفلي.
  String? get ctaLabel => switch (screen) {
        AppScreen.home => 'اطلب مياه',
        AppScreen.order => 'متابعة الطلب',
        AppScreen.checkout => 'تأكيد الطلب',
        _ => null,
      };

  Future<void> onCtaTap() async {
    switch (screen) {
      case AppScreen.home:
        setScreen(AppScreen.order);
      case AppScreen.order:
        setScreen(AppScreen.checkout);
      case AppScreen.checkout:
        // `await` لا نداءٌ معلَّق: `confirmOrder` صار يرحل إلى الخادم وقد
        // يفشل، وتركُه بلا انتظار يبتلع الرفض — فيضغط الزبون «تأكيد» ولا
        // يتغيّر شيء على الشاشة ولا يعرف لماذا.
        await confirmOrder();
      default:
        break;
    }
  }
}
