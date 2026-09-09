import 'package:flutter/material.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/driver_chrome.dart';
import '../state/driver_state.dart';

/// شاشة "الأرباح" — ملخّص أرباح الأسبوع، طلبات مكتملة، نقد للتوريد،
/// وسجل التسليمات الأخيرة.
class EarningsScreen extends StatelessWidget {
  const EarningsScreen({super.key});

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
              Text('الأرباح', style: AquaText.arabic(size: 22, weight: FontWeight.w700, color: colors.ink)),
              const SizedBox(height: 16),
              _WeeklyEarningsCard(colors: colors),
              const SizedBox(height: 16),
              _StatsRow(colors: colors),
              const SizedBox(height: 16),
              Text('سجل التسليمات', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
              const SizedBox(height: 10),
              _HistoryCard(colors: colors),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const DriverBottomNav(),
    );
  }
}

class _WeeklyEarningsCard extends StatelessWidget {
  const _WeeklyEarningsCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final bars = DriverState.weeklyBars;
    return AquaCard(
      padding: const EdgeInsets.all(20),
      gradient: AquaColors.heroGradient,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('أرباح هذا الأسبوع', style: AquaText.arabic(size: 12.5, color: colors.sky200)),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(DriverState.weeklyEarnings, style: AquaText.numeric(size: 27, weight: FontWeight.w700, color: Colors.white)),
              const SizedBox(width: 6),
              Text('JOD', style: AquaText.numeric(size: 13, weight: FontWeight.w500, color: colors.sky200)),
            ],
          ),
          const SizedBox(height: 16),
          // الأعمدة تُرسم بترتيب الأيام من السبت (يمين) إلى الجمعة
          // (يسار) — وهو ترتيب RTL الطبيعي، فيبقى الـRow على اتجاه
          // الشجرة دون قلب، والعمود المميّز (السادس) يقابل يومه.
          SizedBox(
            height: 70,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                for (var i = 0; i < bars.length; i++) ...[
                  if (i > 0) const SizedBox(width: 8),
                  Expanded(
                    child: FractionallySizedBox(
                      heightFactor: bars[i],
                      alignment: Alignment.bottomCenter,
                      child: Container(
                        decoration: BoxDecoration(
                          color: i == 5 ? Colors.white : Colors.white.withValues(alpha: 0.32),
                          borderRadius: const BorderRadius.only(topLeft: Radius.circular(4), topRight: Radius.circular(4)),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('السبت', style: AquaText.arabic(size: 11, color: colors.sky200)),
              Text('الجمعة', style: AquaText.arabic(size: 11, color: colors.sky200)),
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
    Widget stat(String label, String value, {Color? valueColor}) => Expanded(
          child: AquaCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                const SizedBox(height: 6),
                Text(value, style: AquaText.numeric(size: 18, weight: FontWeight.w700, color: valueColor ?? colors.ink)),
              ],
            ),
          ),
        );

    return Row(
      children: [
        stat('طلبات مكتملة', DriverState.completedOrders),
        const SizedBox(width: 10),
        stat('نقد للتوريد', DriverState.cashToRemit, valueColor: colors.warningStrong),
      ],
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final (id, place, _, status, amount) in DriverState.history)
            Padding(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(id, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: colors.ink)),
                        Text(place, style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                      ],
                    ),
                  ),
                  StatusPill(
                    label: status,
                    background: status == 'مسلّم' ? colors.successBg : colors.dangerBg,
                    foreground: status == 'مسلّم' ? colors.successFg : colors.dangerFg,
                  ),
                  const SizedBox(width: 10),
                  Text(
                    amount,
                    style: AquaText.numeric(
                      size: 13.5,
                      weight: FontWeight.w700,
                      color: status == 'ملغي' ? colors.ink4 : colors.ink,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
