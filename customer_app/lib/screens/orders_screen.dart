import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';

/// شاشة "طلباتي" — سجل الطلبات بفلاتر حالة، مع إمكانية تتبّع الطلب
/// الجاري أو إعادة طلب سابق.
class OrdersScreen extends StatelessWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('طلباتي', style: AquaText.arabic(size: 22, weight: FontWeight.w700, color: colors.ink)),
              const SizedBox(height: 14),
              _FilterRow(colors: colors),
              const SizedBox(height: 14),
              _OrderCard(
                id: 'AQ-1042',
                statusLabel: 'في الطريق',
                statusBg: colors.infoBg,
                statusFg: colors.infoFg,
                dateItems: '٨ سبتمبر · قارورة 18.9 لتر × 2',
                amount: '5.250 JOD',
                actionLabel: 'تتبّع',
                onAction: () => context.read<AppState>().setScreen(AppScreen.track),
                colors: colors,
              ),
              const SizedBox(height: 12),
              _OrderCard(
                id: 'AQ-1039',
                statusLabel: 'تم التسليم',
                statusBg: colors.successBg,
                statusFg: colors.successFg,
                dateItems: '٦ سبتمبر · عبوة 4×5 لتر × 3',
                amount: '5.500 JOD',
                actionLabel: 'إعادة الطلب',
                onAction: null,
                colors: colors,
              ),
              const SizedBox(height: 12),
              _OrderCard(
                id: 'AQ-1031',
                statusLabel: 'تم التسليم',
                statusBg: colors.successBg,
                statusFg: colors.successFg,
                dateItems: '٢ سبتمبر · قارورة 18.9 لتر × 1',
                amount: '2.750 JOD',
                actionLabel: 'إعادة الطلب',
                onAction: null,
                colors: colors,
              ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const AppBottomNav(),
    );
  }
}

class _FilterRow extends StatelessWidget {
  const _FilterRow({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    Widget chip(String label, bool active) => Container(
          margin: const EdgeInsets.only(left: 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: active ? colors.deep : colors.surface,
            border: active ? null : Border.all(color: colors.line),
            borderRadius: BorderRadius.circular(AquaRadii.pill),
          ),
          child: Text(label, style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: active ? Colors.white : colors.ink2)),
        );

    return Row(children: [chip('الكل', true), chip('قيد التنفيذ', false), chip('مكتملة', false)]);
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.id,
    required this.statusLabel,
    required this.statusBg,
    required this.statusFg,
    required this.dateItems,
    required this.amount,
    required this.actionLabel,
    required this.onAction,
    required this.colors,
  });

  final String id;
  final String statusLabel;
  final Color statusBg;
  final Color statusFg;
  final String dateItems;
  final String amount;
  final String actionLabel;
  final VoidCallback? onAction;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(id, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: colors.ink3)),
              const Spacer(),
              StatusPill(label: statusLabel, background: statusBg, foreground: statusFg),
            ],
          ),
          const SizedBox(height: 6),
          Text(dateItems, style: AquaText.arabic(size: 12.5, color: colors.ink2)),
          const SizedBox(height: 10),
          Row(
            children: [
              Text(amount, style: AquaText.numeric(size: 14, weight: FontWeight.w700, color: colors.ink)),
              const Spacer(),
              GestureDetector(
                onTap: onAction,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(border: Border.all(color: colors.deep, width: 1.5), borderRadius: BorderRadius.circular(AquaRadii.pill)),
                  child: Text(actionLabel, style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: colors.deep)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
