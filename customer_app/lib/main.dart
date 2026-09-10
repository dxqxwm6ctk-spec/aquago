import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/api_client.dart';
import 'core/push_service.dart';
import 'core/social_auth.dart';
import 'core/theme/aqua_theme.dart';
import 'firebase_options.dart';
import 'screens/auth_gate.dart';
import 'state/app_state.dart';

/// مفتاح مُلاح التطبيق — للتنقّل من خارج شجرة الواجهة (ضغطة على إشعار).
final appNavigatorKey = GlobalKey<NavigatorState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // فشل التهيئة لا يمنع التطبيق من العمل: من لا إشعارات عنده يطلب مياهه
  // كالعادة، ولا يُحبس على شاشة بيضاء لأن Firebase تعثّر.
  try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    firebaseReady = true;
  } catch (e) {
    // **الأثر أوسع من الإشعارات**: الدخول بجوجل وآبل يمرّ بـFirebaseAuth
    // كذلك، فيسقط معها. `firebaseReady` يبقى false فتُعلن شاشة الدخول عطلاً
    // في التطبيق بدل أن تطلب من الزبون إعادة محاولةٍ لن تنجح أبداً.
    debugPrint('[init] تعذّرت تهيئة Firebase — الدخول والإشعارات معطّلة: $e');
  }
  runApp(const AquaGoApp());
}

/// نقطة دخول تطبيق الزبون — 7 شاشات (الرئيسية، اختيار المياه، تأكيد
/// الطلب، التتبّع، طلباتي، المحفظة، الحساب)، مبنيّة عن تصميم Claude
/// Design (Aqua Go.dc.html) ضمن مشروع "Aqua Go Water Delivery".
class AquaGoApp extends StatelessWidget {
  const AquaGoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      // `bootstrap` يقرأ التوكنين من القرص ويجلب الحساب — يُطلق فور الإنشاء
      // لا بعد أول إطار: `AuthGate` ينتظره ولا يعرض شيئاً قبله.
      create: (_) => AppState()..bootstrap(),
      child: MaterialApp(
        title: 'AquaGo',
        navigatorKey: appNavigatorKey,
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        theme: AquaTheme.light(),
        darkTheme: AquaTheme.dark(),
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child!,
        ),
        home: const _PushHost(child: AuthGate()),
      ),
    );
  }
}

/// يهيّئ الإشعارات ويربط وجهات الضغطة، ويزامن الشارة مع دورة حياة
/// التطبيق (docs/NOTIFICATIONS_GUIDE.md §10 و§11).
///
/// الربط هنا لا داخل `PushService` حتى تبقى الخدمة بلا معرفة بالشاشات.
class _PushHost extends StatefulWidget {
  const _PushHost({required this.child});

  final Widget child;

  @override
  State<_PushHost> createState() => _PushHostState();
}

class _PushHostState extends State<_PushHost> with WidgetsBindingObserver {
  /// عميل الجلسة نفسه الذي يمسك التوكنين — لا نسخة ثانية: عميلٌ منفصل لا يرى
  /// توكن الدخول، فيُرفض تسجيل الجهاز أبداً ولا يصل إشعار.
  ApiClient get _api => context.read<AppState>().api;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    final push = PushService.instance;
    push.onOpenChat = _openOrder;
    push.onOpenOrder = _openOrder;
    push.onOpenSupport = () => _openScreen(AppScreen.account);

    // بعد أول إطار: طلب الإذن يعرض حواراً من النظام، ولا يصحّ وسط البناء.
    //
    // التسجيل يقع هنا لمن جلسته محفوظة من تشغيل سابق؛ ومن يدخل الآن يُسجَّل
    // من `AppState._social` فور نجاح الدخول.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final api = _api;
      if (api.isAuthenticated) push.init(api);
      context.read<AppState>().refreshUnreadNotifications(api);
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // العودة من الخلفية: الشارة قد تكون تغيّرت بإشعارات وصلت والتطبيق
    // مغلق، والمستخدم قد يكون منح الإذن من إعدادات النظام للتوّ.
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<AppState>().refreshUnreadNotifications(_api);
      final push = PushService.instance;
      if (push.status.value == PushStatus.permissionDenied) push.retry();
    }
  }

  /// لا نكدّس شاشات فوق بعضها مع كل ضغطة إشعار.
  void _openScreen(AppScreen screen) {
    appNavigatorKey.currentState?.popUntil((r) => r.isFirst);
    if (!mounted) return;
    context.read<AppState>().setScreen(screen);
  }

  /// شاشة التتبّع هي التي تُظهر حالة الطلب وتحمل أزرار التصرّف.
  ///
  /// معرّف الطلب لا يُستعمل بعد: `AppState` يمسك طلباً واحداً ثابتاً
  /// (mock)، فلا مكان الآن لفتح طلبٍ بعينه — يصير له معنى حين تُربط
  /// الشاشة بالخادم.
  void _openOrder(String orderId) => _openScreen(AppScreen.track);

  @override
  Widget build(BuildContext context) => widget.child;
}
