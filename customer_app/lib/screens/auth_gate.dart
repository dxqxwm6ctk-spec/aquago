import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/theme/aqua_theme.dart';
import '../state/app_state.dart';
import 'app_shell.dart';
import 'gate_screens.dart';
import 'login_screen.dart';

/// بوّابة ما قبل التطبيق: تختار الشاشة بحسب حالة الجلسة.
///
/// الترتيب مقصود — الشروط أولاً (لا يُستعمل شيء قبل الموافقة)، ثم تأكيد
/// الاسم. **توثيق الهاتف ليس هنا**: يُطلب قبل أول طلب لا عند الدخول، فالزبون
/// له أن يتصفّح الكتالوج ويرى الأسعار قبل أن يُسأل رقمه.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();

    // قراءة التوكنين من القرص — لحظة قصيرة لا تصحّ فيها وميضُ شاشة دخول لمن
    // هو داخلٌ أصلاً.
    if (state.bootstrapping) {
      return Scaffold(
        backgroundColor: context.colors.bg,
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    if (!state.isLoggedIn) return const LoginScreen();
    if (state.mustAcceptTerms) return const TermsGateScreen();
    if (state.mustConfirmName) return const ConfirmNameScreen();
    return const AppShell();
  }
}
