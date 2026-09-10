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

/// معرّف القناة الافتراضية — يجب أن يطابق ما يرسله الخادم في حمولة
/// أندرويد (`fcm.service.ts`: `aquago_default`)، وإلا سقط الإشعار على
/// قناة النظام الافتراضية بصوتها العادي.
const kDefaultChannelId = 'aquago_default';
const kDefaultChannelName = 'إشعارات Aqua Go';

/// أثر مرحلي لمسار الإشعارات — يُطبع في debug وفي سجل النظام على الجهاز.
///
/// مسار Push يعبر ست طبقات (إذن النظام ← APNs ← FCM ← الخادم ← قاعدة
/// البيانات ← الجهاز)، وينكسر بصمت إن ابتلع كل فشلٍ `catch (_) {}`.
/// هذه الأسطر تجيب «أين وقف؟» بلا فتح Xcode: `flutter logs`.
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
}

/// أين وصل تسجيل هذا الجهاز لاستقبال الإشعارات.
///
/// الفشل هنا لا يترك أثراً بغير حالة معلنة: الزبون الذي رفض الإذن — أو
/// سُجّل جهازه ثم سقطت الشبكة — يرى مفتاح إشعارات مفعّلاً ولا يصله شيء،
/// بلا ما يفسّر ذلك.
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

/// استقبال إشعارات Push وعرضها وتوجيه الضغطة عليها
/// (docs/NOTIFICATIONS_GUIDE.md §8).
class PushService {
  PushService._();
  static final PushService instance = PushService._();

  final _local = FlutterLocalNotificationsPlugin();

  /// يتغيّر مع كل انتقال حالة — الشاشات تستمع بلا حاجة لتحديث يدوي.
  final ValueNotifier<PushStatus> status =
      ValueNotifier<PushStatus>(PushStatus.idle);

  String? _lastToken;
  bool _messagingReady = false;

  /// آخر عميل استُخدم للتسجيل — [retry] تحتاجه بلا أن تطلبه من الشاشة.
  ApiClient? _api;

  /// المحادثة المفتوحة الآن — إشعارها ضجيج، فالرسالة ظاهرة أصلاً.
  String? openChatOrderId;

  /// روابط التنقّل — تضبطها طبقة الواجهة لا الخدمة، حتى تبقى الخدمة بلا
  /// معرفة بالشاشات.
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

  Future<void> init(ApiClient api) async {
    _api = api;
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
          // الحمولة هي الوجهة كاملة (نوع + معرّفات) لا معرّف الطلب وحده.
          onDidReceiveNotificationResponse: (res) {
            final raw = res.payload;
            if (raw == null || raw.isEmpty) return;
            try {
              _route(Map<String, dynamic>.from(jsonDecode(raw) as Map));
            } catch (_) {}
          },
        );
        await _local
            .resolvePlatformSpecificImplementation<
                AndroidFlutterLocalNotificationsPlugin>()
            ?.createNotificationChannel(const AndroidNotificationChannel(
              kDefaultChannelId,
              kDefaultChannelName,
              importance: Importance.high,
            ));

        FirebaseMessaging.onMessage.listen(_showForeground);
        FirebaseMessaging.onMessageOpenedApp.listen(_handleOpened);
        // فُتح التطبيق من إشعارٍ وهو مغلق تماماً.
        final opening = await FirebaseMessaging.instance.getInitialMessage();
        if (opening != null) _handleOpened(opening);
        FirebaseMessaging.instance.onTokenRefresh
            .listen((t) => _register(api, t));
        _messagingReady = true;
        _log('messaging ready');
      } catch (e) {
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
    final n = message.notification;
    if (n == null) return;
    final type = message.data['type'];
    final orderId = message.data['orderId'];
    // رسالة محادثة والشاشة مفتوحة على الطلب نفسه — تصل عبر الـSocket
    // وتظهر في الخيط فوراً، فإشعارها تكرار.
    if (type == 'ORDER_MESSAGE' && orderId == openChatOrderId) return;
    _local.show(
      n.hashCode,
      n.title,
      n.body,
      const NotificationDetails(
        android:
            AndroidNotificationDetails(kDefaultChannelId, kDefaultChannelName),
        iOS: DarwinNotificationDetails(presentAlert: true, presentSound: true),
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

  /// إعادة محاولة بعد فشل — من زرٍّ في شاشة الإشعارات، أو بعد أن يمنح
  /// المستخدم الإذن من إعدادات النظام ويعود للتطبيق.
  Future<void> retry() async {
    final api = _api;
    if (api == null) return;
    if (status.value == PushStatus.working) return;
    status.value = PushStatus.idle;
    await init(api);
  }

  Future<void> _register(ApiClient api, String token) async {
    // مسار التسجيل خلف حارس JWT: بلا دخولٍ يرجع 401 فتُعلَن الحالة فشلاً
    // بلا سبب حقيقي. نبقى `idle` حتى يوجد توكن دخول، ويعيد
    // [retry] المحاولة بعده.
    if (!api.isAuthenticated) {
      _log('تخطّي التسجيل — لا توكن دخول بعد');
      _lastToken = token;
      status.value = PushStatus.idle;
      return;
    }
    try {
      await api.post('/device-tokens', {
        'token': token,
        // ثابتٌ 'ANDROID' كان يسجّل أجهزة iOS أندرويد.
        'platform': Platform.isIOS ? 'IOS' : 'ANDROID',
        'app': 'CUSTOMER',
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
  /// بواجهة النظام مباشرة لا بإشعار صامت: إشعارٌ بشارة ثم إلغاؤه يومض،
  /// وiOS لا يطبّق `presentBadge` إلا والتطبيق بالمقدّمة — فتبقى الشارة
  /// على رقم قديم ويظهر «1» على أيقونة وارِدُها فارغ.
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
  /// إعادة التشغيل، فمن أعاد الفتح ثم خرج يبقى جهازه يتلقّى الإشعارات.
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
