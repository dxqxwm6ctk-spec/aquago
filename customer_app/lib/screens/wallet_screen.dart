import 'package:flutter/material.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';

/// شاشة "المحفظة" — الرصيد المتاح، إحصائيات الاستخدام، وسجل العمليات
/// الأخيرة.
class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key});

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
              Text('المحفظة', style: AquaText.arabic(size: 22, weight: FontWeight.w700, color: colors.ink)),
              const SizedBox(height: 16),
              _BalanceCard(colors: colors),
              const SizedBox(height: 16),
              _StatsRow(colors: colors),
              const SizedBox(height: 16),
              Text('أحدث العمليات', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
              const SizedBox(height: 10),
              _TransactionsCard(colors: colors),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const AppBottomNav(),
    );
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: const EdgeInsets.all(20),
      gradient: AquaColors.heroGradient,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('الرصيد المتاح', style: AquaText.arabic(size: 12.5, color: colors.sky200)),
          const SizedBox(height: 6),
          Text('12.750 JOD', style: AquaText.numeric(size: 24, weight: FontWeight.w700, color: Colors.white)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(AquaRadii.button)),
                  child: Text('شحن الرصيد', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.deep)),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 1.5), borderRadius: BorderRadius.circular(AquaRadii.button)),
                  child: Text('كود خصم', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: Colors.white)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatsRow extends StatelessWidget {
  const _StatsRow({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    Widget stat(String label, String value) => Expanded(
          child: AquaCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                const SizedBox(height: 6),
                Text(value, style: AquaText.numeric(size: 18, weight: FontWeight.w700, color: colors.ink)),
              ],
            ),
          ),
        );

    return Row(children: [stat('قوارير مسترجعة', '14'), const SizedBox(width: 10), stat('لتر تم توصيله', '265')]);
  }
}

class _TransactionsCard extends StatelessWidget {
  const _TransactionsCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final rows = [
      ('شحن رصيد', '٧ سبتمبر', '+10.000', true),
      ('طلب AQ-1039', '٦ سبتمبر', '−5.500', false),
      ('طلب AQ-1031', '٢ سبتمبر', '−2.750', false),
    ];
    return AquaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final (title, date, amount, isCredit) in rows)
            Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(color: isCredit ? colors.sky100 : colors.bg2, shape: BoxShape.circle),
                    child: Icon(
                      isCredit ? Icons.south_west_rounded : Icons.north_east_rounded,
                      size: 16,
                      color: isCredit ? colors.deep : colors.ink3,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: AquaText.arabic(size: 13, weight: FontWeight.w600, color: colors.ink)),
                        Text(date, style: AquaText.arabic(size: 11, color: colors.ink3)),
                      ],
                    ),
                  ),
                  Text(
                    amount,
                    style: AquaText.numeric(size: 13, weight: FontWeight.w700, color: isCredit ? colors.successFg : colors.ink),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
