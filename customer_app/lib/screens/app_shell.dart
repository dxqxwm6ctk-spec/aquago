import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import 'account_screen.dart';
import 'checkout_screen.dart';
import 'home_screen.dart';
import 'orders_screen.dart';
import 'product_select_screen.dart';
import 'track_screen.dart';
import 'wallet_screen.dart';

/// جذر تطبيق الزبون — يختار الشاشة الحالية حسب `AppState.screen`، بلا
/// `Navigator` مكدَّس (كل شاشة تستبدل الأخرى، تمامًا كالتصميم الأصلي).
class AppShell extends StatelessWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context) {
    final screen = context.watch<AppState>().screen;
    return switch (screen) {
      AppScreen.home => const HomeScreen(),
      AppScreen.order => const ProductSelectScreen(),
      AppScreen.checkout => const CheckoutScreen(),
      AppScreen.track => const TrackScreen(),
      AppScreen.orders => const OrdersScreen(),
      AppScreen.wallet => const WalletScreen(),
      AppScreen.account => const AccountScreen(),
    };
  }
}
