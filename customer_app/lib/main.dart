import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'core/theme/aqua_theme.dart';
import 'screens/app_shell.dart';
import 'state/app_state.dart';

void main() {
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
      create: (_) => AppState(),
      child: MaterialApp(
        title: 'AquaGo',
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        theme: AquaTheme.light(),
        darkTheme: AquaTheme.dark(),
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child!,
        ),
        home: const AppShell(),
      ),
    );
  }
}
