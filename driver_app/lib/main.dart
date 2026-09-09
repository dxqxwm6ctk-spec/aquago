import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'core/theme/aqua_theme.dart';
import 'screens/driver_shell.dart';
import 'state/driver_state.dart';

void main() {
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
      create: (_) => DriverState(),
      child: MaterialApp(
        title: 'AquaGo Driver',
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        theme: AquaTheme.light(),
        darkTheme: AquaTheme.dark(),
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child!,
        ),
        home: const DriverShell(),
      ),
    );
  }
}
