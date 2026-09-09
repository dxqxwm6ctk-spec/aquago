import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/driver_state.dart';
import 'active_delivery_screen.dart';
import 'earnings_screen.dart';
import 'order_detail_screen.dart';
import 'shift_screen.dart';

/// جذر تطبيق السائق — يختار الشاشة الحالية حسب `DriverState.screen`،
/// بلا `Navigator` مكدَّس (كل شاشة تستبدل الأخرى، تمامًا كالتصميم
/// الأصلي حيث التنقّل عبر تبديل حالة لا دفع/سحب صفحات).
class DriverShell extends StatelessWidget {
  const DriverShell({super.key});

  @override
  Widget build(BuildContext context) {
    final screen = context.watch<DriverState>().screen;
    return switch (screen) {
      DriverScreen.shift => const ShiftScreen(),
      DriverScreen.detail => const OrderDetailScreen(),
      DriverScreen.run => const ActiveDeliveryScreen(),
      DriverScreen.earn => const EarningsScreen(),
    };
  }
}
