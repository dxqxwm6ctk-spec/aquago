import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/theme/aqua_theme.dart';
import '../state/driver_state.dart';
import 'driver_shell.dart';
import 'login_screen.dart';

/// بوّابة ما قبل التطبيق: شاشة الدخول أو الوردية.
///
/// لا بوابتَي شروط واسم هنا خلاف تطبيق الزبون: حساب السائق تُنشئه الوكالة
/// وتُقرّ بياناته، فليس له اسمٌ آتٍ من جوجل يُراجَع عند الباب.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();

    // قراءة التوكنين من القرص — لحظة قصيرة لا تصحّ فيها وميضُ شاشة دخول لمن
    // هو داخلٌ أصلاً، والسائق قد يكون في منتصف توصيلة.
    if (state.bootstrapping) {
      return Scaffold(
        backgroundColor: context.colors.bg,
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    if (!state.isLoggedIn) return const LoginScreen();
    return const DriverShell();
  }
}
