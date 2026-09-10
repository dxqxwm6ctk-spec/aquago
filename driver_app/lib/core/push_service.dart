import 'dart:convert';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_app_badge/flutter_app_badge.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../firebase_options.dart';
import 'api_client.dart';
import 'notification_route.dart';
import 'offer_alert.dart';

/// معرّفات القنوات — يجب أن تطابق ما يرسله الخادم في حمولة أندرويد
/// (`fcm.service.ts`: `aquago_default` و`aquago_offers`)، وإلا سقط الإشعار
/// على القناة الافتراضية بصوتها العادي.
const kDefaultChannelId = 'aquago_default';
const kDefaultChannelName = 'إشعارات Aqua Go';
const kOffersChannelId = 'aquago_offers';
const kOffersChannelName = 'عروض التوصيل';

/// اسم ملف النغمة بلا امتداد — كما يُذكر في `RawResourceAndroidNotificationSound`
/// وفي حقل `sound` بحمولة الخادم.
const kOfferSound = 'offer_alert_aquago';

/// أثر مرحلي لمسار الإشعارات — يُطبع في debug وفي سجل النظام على الجهاز.
///
/// مسار Push يعبر ست طبقات (إذن النظام ← APNs ← FCM ← الخادم ← قاعدة
/// البيانات ← الجهاز)، وينكسر بصمت إن ابتلع كل فشلٍ `catch (_) {}`.
void _log(String stage, [Object? detail]) {
  debugPrint('[push] $stage${detail == null ? '' : ' — $detail'}');
}

/// يعمل بعزلٍ (isolate) منفصل عند وصول رسالة والتطبيق مغلق/بالخلفية —
/// لازم يبقى top-level ويهيّئ Firebase بنفسه.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp(
    options: DefaultFirebaseOptions.currentPlatform,
  );
  // هنا وحده يمكن أن يُسمع العرض والتطبيق مغلق.
  //
  // هذه الدالة تعمل في عزلٍ منفصل يوقظه النظام لحظة وصول الرسالة، ولو كان
  // التطبيق مغلقاً بالكامل. وهي الفرصة الوحيدة لتشغيل نغمة متكررة: نغمة
  // القناة رنّةٌ واحدة يقرّرها النظام ولا سبيل لإطالتها.
  //
  // القيد الباقي: النظام يمهل هذا العزل ثوانيَ معدودة ثم يجمّده — فالنغمة
  // تدوم ما دام العزل حيّاً لا أربعين ثانية. تظلّ أطول بكثير من رنّة واحدة.
  if (message.data['type'] != 'OFFER_RECEIVED') return;
  try {
    await OfferAlert.instance.start();
  } catch (e) {
    debugPrint('تعذّر تنبيه العرض في الخلفية: $e');
  }
}

/// أين وصل تسجيل هذا الجهاز لاستقبال الإشعارات.
///
/// الفشل هنا لا يترك أثراً بغير حالة معلنة: السائق الذي رفض الإذن — أو
/// سُجّل جهازه ثم سقطت الشبكة — يظنّ نفسه متاحاً ولا يصله عرض، بلا ما
/// يفسّر ذلك.
enum PushStatus {
  /// لم تبدأ المحاولة بعد (أو المنصّة لا تدعمها كالويب).
  idle,

  /// جارٍ طلب الإذن/التسجيل.
  working,

  /// الجهاز مسجَّل في الخادم — الإشعارات تصل فعلاً.
  registered,

  /// المستخدم رفض إذن الإشعارات من النظام.
  permissionDenied,

  /// خدمات Google Play غائبة أو Firebase تعذّر تهيئته.
  unavailable,

  /// التسجيل في الخادم فشل (شبكة/خادم) — قابل للإعادة.
  registrationFailed,
}

/// استقبال إشعارات Push وعرضها وتوجيه الضغطة عليها — نسخة السائق
/// (docs/NOTIFICATIONS_GUIDE.md §9).
class PushService {
  PushService._();
  static final PushService instance = PushService._();

  final _local = FlutterLocalNotificationsPlugin();

  /// يتغيّر مع كل انتقال حالة — الشاشات تستمع بلا حاجة لتحديث يدوي.
  final ValueNotifier<PushStatus> status =
      ValueNotifier<PushStatus>(PushStatus.idle);

  String? _lastToken;
  bool _messagingReady = false;

  ApiClient? _api;

  /// المحادثة المفتوحة الآن — إشعارها ضجيج، فالرسالة ظاهرة أصلاً.
  String? openChatOrderId;

  /// هل ورقة هذا العرض معروضة أصلاً من الـSocket؟ تضبطها طبقة الواجهة.
  bool Function(String? offerId)? _isOfferAlreadyShown;

  /// وصل عرضٌ عبر Push — الواجهة تجلب تفاصيله إن كان الـSocket ساقطاً.
  VoidCallback? _onOfferPush;

  /// روابط التنقّل — تضبطها طبقة الواجهة لا الخدمة.
  void Function(String orderId)? onOpenChat;
  void Function(String orderId)? onOpenOrder;
  VoidCallback? onOpenSupport;

  bool get isRegistered => status.value == PushStatus.registered;

  void _handleOpened(RemoteMessage message) => _route(message.data);

  /// الوجهة من حمولة الإشعار — واحدة لإشعار النظام ولبطاقة الإشعار داخل
  /// التطبيق. حمولة FCM كلها نصوص.
  void _route(Map<String, dynamic> data) {
    final type = '${data['type'] ?? ''}';
    final orderId = data['orderId'] is String ? data['orderId'] as String : null;
    final hasOrder = orderId != null && orderId.isNotEmpty;
    switch (notifDestination(type,
        hasOrder: hasOrder, hasTicket: data['ticketId'] != null)) {
      case NotifDestination.chat:
        onOpenChat?.call(orderId!);
      case NotifDestination.order:
        onOpenOrder?.call(orderId!);
      case NotifDestination.support:
        onOpenSupport?.call();
      case NotifDestination.none:
        break;
    }
  }

  Future<void> init(
    ApiClient api, {
    bool Function(String? offerId)? isOfferAlreadyShown,
    VoidCallback? onOfferPush,
  }) async {
    _api = api;
    _isOfferAlreadyShown = isOfferAlreadyShown ?? _isOfferAlreadyShown;
    _onOfferPush = onOfferPush ?? _onOfferPush;
    if (kIsWeb) return;
    if (status.value == PushStatus.registered ||
        status.value == PushStatus.working) {
      return;
    }
    status.value = PushStatus.working;

    // التهيئة المحلية مرة واحدة: إعادتها مع كل محاولة تسجيل تُراكم
    // مستمعين يعرضون الإشعار نفسه مرتين.
    if (!_messagingReady) {
      try {
        await _local.initialize(
          const InitializationSettings(
            android: AndroidInitializationSettings('@mipmap/launcher_icon'),
            // بلا هذه الكتلة لا يعرض iOS أي إشعار محلي — والمقدّمة على iOS
            // لا تعرض إشعارات FCM تلقائياً. الأذونات تُطلب من
            // FirebaseMessaging لا من هنا.
            iOS: DarwinInitializationSettings(
              requestAlertPermission: false,
              requestBadgePermission: false,
              requestSoundPermission: false,
            ),
          ),
          onDidReceiveNotificationResponse: (res) {
            final raw = res.payload;
            if (raw == null || raw.isEmpty) return;
            try {
              _route(Map<String, dynamic>.from(jsonDecode(raw) as Map));
            } catch (_) {}
          },
        );

        final android = _local.resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();
        await android?.createNotificationChannel(
          const AndroidNotificationChannel(
            kDefaultChannelId,
            kDefaultChannelName,
            importance: Importance.high,
          ),
        );
        // قناة مستقلة لعروض التوصيل.
        //
        // النغمة المتكررة يشغّلها OfferAlert من شيفرة Dart، فلا تعمل
        // والتطبيق مغلق بالكامل. وقناة الإشعارات العامة تُسمع برنّة النظام
        // كأي خبر، فيمرّ عرضٌ مهلته ثوانٍ كما يمرّ إشعار.
        //
        // بمعرّف جديد لا بتعديل القديمة: أندرويد يجمّد إعدادات القناة عند
        // إنشائها أول مرة، فتغيير صوت قناة قائمة لا يصل من ثبّت التطبيق
        // قبله.
        await android?.createNotificationChannel(
          const AndroidNotificationChannel(
            kOffersChannelId,
            kOffersChannelName,
            description: 'طلب توصيل جديد بانتظار ردّك — بنغمة مميّزة',
            importance: Importance.max,
            sound: RawResourceAndroidNotificationSound(kOfferSound),
            enableVibration: true,
          ),
        );

        FirebaseMessaging.onMessage.listen(_showForeground);
        FirebaseMessaging.onMessageOpenedApp.listen(_handleOpened);
        final opening = await FirebaseMessaging.instance.getInitialMessage();
        if (opening != null) _handleOpened(opening);
        FirebaseMessaging.instance.onTokenRefresh
            .listen((t) => _register(api, t));
        _messagingReady = true;
        _log('messaging ready');
      } catch (e) {
        // الراية تبقى مخفوضة حتى تظلّ إعادة المحاولة ممكنة في الفتحة
        // التالية: رفعُها قبل الـtry يجعل أي تعثّر عابر يقفل الإشعارات على
        // هذا الجهاز نهائياً (§9.4).
        _messagingReady = false;
        _log('messaging setup FAILED', e);
        status.value = PushStatus.unavailable;
        return;
      }
    }

    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      _log('permission', settings.authorizationStatus);
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        status.value = PushStatus.permissionDenied;
        return;
      }
      final token = await _fetchToken();
      if (token == null) {
        _log('FCM token NULL — لا تسجيل');
        status.value = PushStatus.unavailable;
        return;
      }
      _log('FCM token',
          '...${token.length > 12 ? token.substring(token.length - 12) : token}');
      await _register(api, token);
    } catch (e) {
      _log('token stage FAILED', e);
      status.value = PushStatus.unavailable;
    }
  }

  /// عرض الإشعار والتطبيق بالمقدّمة — لا أندرويد ولا iOS يعرضه تلقائياً.
  void _showForeground(RemoteMessage message) {
    final type = message.data['type'];
    final isOffer = type == 'OFFER_RECEIVED';
    // الـPush هو طريق العرض الثاني: إن كان الـSocket ساقطاً فهو وحده من
    // يعرف بالعرض، وبدونه تنقضي المهلة والسائق يرى إشعاراً لا تقابله ورقة.
    if (isOffer) _onOfferPush?.call();

    final n = message.notification;
    if (n == null) return;
    // الورقة معروضة أصلاً من الـSocket — الإشعار تكرار.
    if (isOffer &&
        (_isOfferAlreadyShown?.call(message.data['offerId'] as String?) ??
            false)) {
      return;
    }
    final orderId = message.data['orderId'];
    if (type == 'ORDER_MESSAGE' && orderId == openChatOrderId) return;

    // العرض يظهر على قناته بنغمته — والمقدّمة كالخلفية في ذلك، فلا يتبدّل
    // الصوت الذي تعلّمه المندوب بحسب أين كان التطبيق.
    _local.show(
      n.hashCode,
      n.title,
      n.body,
      NotificationDetails(
        android: isOffer
            ? const AndroidNotificationDetails(
                kOffersChannelId,
                kOffersChannelName,
                importance: Importance.max,
                priority: Priority.max,
                sound: RawResourceAndroidNotificationSound(kOfferSound),
                // يعامله النظام كنداء فيخترق وضع عدم الإزعاج.
                category: AndroidNotificationCategory.call,
              )
            : const AndroidNotificationDetails(
                kDefaultChannelId,
                kDefaultChannelName,
              ),
        iOS: const DarwinNotificationDetails(
          presentAlert: true,
          presentSound: true,
        ),
      ),
      payload: jsonEncode(message.data),
    );
  }

  /// على iOS لا يصدر توكن FCM قبل أن يسلّم APNs توكنه، وطلبه مبكراً يرجع
  /// null فيبقى الجهاز بلا تسجيل. ننتظره قليلاً أولاً.
  Future<String?> _fetchToken() async {
    if (!kIsWeb && Platform.isIOS) {
      String? apns;
      // عشر محاولات لا خمس: على شبكة بطيئة أو إقلاع بارد قد يتأخر APNs أكثر.
      for (var i = 0; i < 10; i++) {
        apns = await FirebaseMessaging.instance.getAPNSToken();
        if (apns != null) break;
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      _log('APNs token', apns == null ? 'NULL بعد 10s — التسجيل لن يتم' : 'وصل');
      if (apns == null) return null;
    }
    return FirebaseMessaging.instance.getToken();
  }

  /// إعادة محاولة بعد فشل — من زرٍّ في شاشة الوردية، أو بعد أن يمنح
  /// السائق الإذن من إعدادات النظام ويعود للتطبيق.
  Future<void> retry() async {
    final api = _api;
    if (api == null) return;
    if (status.value == PushStatus.working) return;
    status.value = PushStatus.idle;
    await init(api);
  }

  Future<void> _register(ApiClient api, String token) async {
    // مسار التسجيل خلف حارس JWT: بلا دخولٍ يرجع 401 فتُعلَن الحالة فشلاً
    // بلا سبب حقيقي. نبقى `idle` حتى يوجد توكن دخول.
    if (!api.isAuthenticated) {
      _log('تخطّي التسجيل — لا توكن دخول بعد');
      _lastToken = token;
      status.value = PushStatus.idle;
      return;
    }
    try {
      await api.post('/device-tokens', {
        'token': token,
        'platform': Platform.isIOS ? 'IOS' : 'ANDROID',
        // يفصل التطبيقين حين يكون الشخص واحداً: السائق قد يطلب لبيته من
        // تطبيق الزبون بنفس `userId` — بلا هذا الحقل يصل عرض التوصيل
        // لتطبيق الزبون.
        'app': 'DRIVER',
      });
      _lastToken = token;
      status.value = PushStatus.registered;
      _log('registered on server');
    } catch (e) {
      _log('server registration FAILED', e);
      status.value = PushStatus.registrationFailed;
    }
  }

  /// يضبط شارة أيقونة التطبيق على [count]. صفرٌ يمسحها.
  ///
  /// iOS وحده: أندرويد لا شارة رقمية له في النظام — المشغّلات تشتقّها من
  /// الإشعارات المعروضة، فتنزل وحدها عند مسحها.
  Future<void> setBadge(int count) async {
    if (kIsWeb || !Platform.isIOS) return;
    try {
      await FlutterAppBadge.count(count);
    } catch (e) {
      _log('badge update FAILED', e);
    }
  }

  /// يحذف توكن هذا الجهاز من الخادم عند الخروج.
  ///
  /// يسأل FCM عن التوكن ولا يكتفي بالمحفوظ بالذاكرة: `_lastToken` يضيع مع
  /// إعادة التشغيل، فمن أعاد الفتح ثم خرج يبقى جهازه يتلقّى العروض.
  Future<void> unregister(ApiClient api) async {
    var token = _lastToken;
    _lastToken = null;
    status.value = PushStatus.idle;
    if (token == null) {
      try {
        token = await FirebaseMessaging.instance.getToken();
      } catch (_) {}
    }
    if (token == null) return;
    try {
      await api.delete('/device-tokens/$token');
    } catch (_) {}
  }
}
