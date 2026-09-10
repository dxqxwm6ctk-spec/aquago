import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/api_client.dart';
import 'core/offer_alert.dart';
import 'core/push_service.dart';
import 'core/social_auth.dart';
import 'core/theme/aqua_theme.dart';
import 'firebase_options.dart';
import 'screens/auth_gate.dart';
import 'state/driver_state.dart';

/// مفتاح مُلاح التطبيق — للتنقّل من خارج شجرة الواجهة (ضغطة على إشعار).
final appNavigatorKey = GlobalKey<NavigatorState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // فشل التهيئة لا يمنع التطبيق من العمل: السائق يكمل وردية جارية، ولا
  // يُحبس على شاشة بيضاء لأن Firebase تعثّر.
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
  runApp(const AquaGoDriverApp());
}

/// نقطة دخول تطبيق السائق — 4 شاشات (الوردية، تفاصيل الطلب، التوصيل
/// الجاري، الأرباح)، مبنيّة عن تصميم Claude Design
/// (Aqua Go Driver.dc.html) ضمن مشروع "Aqua Go Water Delivery".
class AquaGoDriverApp extends StatelessWidget {
  const AquaGoDriverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      // `bootstrap` يقرأ التوكنين من القرص ويجلب الحساب — يُطلق فور الإنشاء
      // لا بعد أول إطار: `AuthGate` ينتظره ولا يعرض شيئاً قبله.
      create: (_) => DriverState()..bootstrap(),
      child: MaterialApp(
        title: 'AquaGo Driver',
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
/// التطبيق (docs/NOTIFICATIONS_GUIDE.md §9 و§10 و§11).
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
  /// توكن الدخول، فيُرفض تسجيل الجهاز أبداً ولا يصل عرضُ طلب.
  ApiClient get _api => context.read<DriverState>().api;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    final push = PushService.instance;
    push.onOpenChat = _openOrder;
    push.onOpenOrder = _openOrder;
    push.onOpenSupport = () => _openScreen(DriverScreen.earn);

    // بعد أول إطار: طلب الإذن يعرض حواراً من النظام، ولا يصحّ وسط البناء.
    //
    // التسجيل يقع هنا لمن جلسته محفوظة من تشغيل سابق؛ ومن يدخل الآن يُسجَّل
    // من `DriverState._social` فور نجاح الدخول.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final api = _api;
      if (api.isAuthenticated) {
        push.init(
          api,
          // الورقة معروضة أصلاً من الـSocket؟ لا شيء بعد يعرض العروض هنا
          // (`DriverState` عرض واحد ثابت)، فالجواب دائماً "لا" حتى تُربط
          // طبقة الـSocket. عندها تسأل هذه الدالةُ الحالةَ عن العرض بمعرّفه.
          isOfferAlreadyShown: (_) => false,
          onOfferPush: _onOfferPush,
        );
      }
      context.read<DriverState>().refreshUnreadNotifications(api);
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
    // مغلق، والسائق قد يكون منح الإذن من إعدادات النظام للتوّ.
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<DriverState>().refreshUnreadNotifications(_api);
      final push = PushService.instance;
      if (push.status.value == PushStatus.permissionDenied) push.retry();
    }
  }

  /// وصل عرضٌ عبر Push والتطبيق بالمقدّمة — النغمة تُشغَّل هنا لا في
  /// معالج الخلفية، فذاك لا يعمل والتطبيق مفتوح.
  void _onOfferPush() {
    OfferAlert.instance.start();
    _openScreen(DriverScreen.shift);
  }

  /// لا نكدّس شاشات فوق بعضها مع كل ضغطة إشعار.
  void _openScreen(DriverScreen screen) {
    appNavigatorKey.currentState?.popUntil((r) => r.isFirst);
    if (!mounted) return;
    context.read<DriverState>().setScreen(screen);
  }

  /// شاشة التوصيل الجاري هي التي تُظهر حالة الطلب وتحمل أزرار التصرّف.
  ///
  /// معرّف الطلب لا يُستعمل بعد: `DriverState` يمسك طلباً واحداً ثابتاً
  /// (mock)، فلا مكان الآن لفتح طلبٍ بعينه — يصير له معنى حين تُربط
  /// الشاشة بالخادم.
  void _openOrder(String orderId) => _openScreen(DriverScreen.run);

  @override
  Widget build(BuildContext context) => widget.child;
}
