import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/aqua_theme.dart';
import '../theme/aqua_colors.dart';
import '../theme/aqua_text.dart';
import '../../state/app_state.dart';

/// عناصر الواجهة المشتركة بين شاشات تطبيق الزبون: الشريط السفلي الثابت
/// (4 تبويبات)، وشريط الإجراء السفلي الاختياري (CTA).

class _NavItem {
  const _NavItem(this.screen, this.label, this.icon);
  final AppScreen screen;
  final String label;
  final IconData icon;
}

const _navItems = [
  _NavItem(AppScreen.home, 'الرئيسية', Icons.home_rounded),
  _NavItem(AppScreen.orders, 'طلباتي', Icons.receipt_long_outlined),
  _NavItem(AppScreen.wallet, 'المحفظة', Icons.credit_card_rounded),
  _NavItem(AppScreen.account, 'الحساب', Icons.person_outline_rounded),
];

/// الشريط السفلي الثابت — 4 تبويبات. لا يتلوّن أي تبويب حين تكون
/// الشاشة الحالية `order`/`checkout`/`track` (ليست من مفاتيح الشريط
/// الأربعة)، طبقًا للتصميم الأصلي بالضبط.
class AppBottomNav extends StatelessWidget {
  const AppBottomNav({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final colors = context.colors;
    return Container(
      height: 76,
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.line)),
      ),
      child: Row(
        children: [
          for (final item in _navItems)
            Expanded(
              child: InkWell(
                onTap: () => state.setScreen(item.screen),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      item.icon,
                      size: 22,
                      color: state.screen == item.screen ? colors.deep : colors.ink3,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      item.label,
                      style: AquaText.arabic(
                        size: 11.5,
                        weight: FontWeight.w600,
                        color: state.screen == item.screen ? colors.deep : colors.ink3,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// شريط الإجراء السفلي: "الإجمالي" + القيمة على اليمين، وزر متدرّج على
/// اليسار — يظهر فقط في home/order/checkout (`AppState.ctaLabel`).
class AppCtaBar extends StatelessWidget {
  const AppCtaBar({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final colors = context.colors;
    final label = state.ctaLabel;
    if (label == null) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.line)),
      ),
      child: Row(
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('الإجمالي', style: AquaText.arabic(size: 11.5, color: colors.ink3)),
              Text(
                state.fmt(state.total),
                style: AquaText.numeric(size: 15, weight: FontWeight.w700, color: colors.ink),
              ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: GestureDetector(
              onTap: state.onCtaTap,
              child: Container(
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  gradient: AquaColors.buttonGradient,
                  borderRadius: BorderRadius.circular(AquaRadii.button),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(label, style: AquaText.arabic(size: 14.5, weight: FontWeight.w700, color: Colors.white)),
                    const SizedBox(width: 8),
                    const Icon(Icons.chevron_left_rounded, color: Colors.white, size: 20),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// نقطة نبض حيّة (ripple) — تُستخدم بجانب "طلبك في الطريق".
class LiveDot extends StatefulWidget {
  const LiveDot({super.key, this.color});
  final Color? color;

  @override
  State<LiveDot> createState() => _LiveDotState();
}

class _LiveDotState extends State<LiveDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? context.colors.aqua;
    return SizedBox(
      width: 9,
      height: 9,
      child: Stack(
        alignment: Alignment.center,
        children: [
          DecoratedBox(decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          AnimatedBuilder(
            animation: _controller,
            builder: (context, child) {
              final t = _controller.value;
              return Opacity(
                opacity: (0.55 * (1 - t)).clamp(0, 1),
                child: Transform.scale(scale: 0.9 + t, child: child),
              );
            },
            child: DecoratedBox(decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          ),
        ],
      ),
    );
  }
}

/// شارة حالة نصية بخلفية ملوّنة (في الطريق/تم التسليم/قيد التحضير/ملغي).
class StatusPill extends StatelessWidget {
  const StatusPill({
    required this.label,
    required this.background,
    required this.foreground,
    super.key,
  });

  final String label;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(AquaRadii.pill)),
      child: Text(label, style: AquaText.arabic(size: 12, weight: FontWeight.w600, color: foreground)),
    );
  }
}

/// بطاقة بيضاء بزوايا مدوّرة كبيرة — الحاوية الأساسية لكل قسم.
class AquaCard extends StatelessWidget {
  const AquaCard({
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color,
    this.gradient,
    super.key,
  });

  final Widget child;
  final EdgeInsets padding;
  final Color? color;
  final Gradient? gradient;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: gradient == null ? (color ?? colors.surface) : null,
        gradient: gradient,
        borderRadius: BorderRadius.circular(AquaRadii.card),
        border: (gradient == null && color == null) ? Border.all(color: colors.line) : null,
      ),
      child: child,
    );
  }
}

/// خطّ متقطّع أفقي بسيط (لا `DottedLine` جاهز في Flutter القياسي).
class DottedDivider extends StatelessWidget {
  const DottedDivider({required this.color, super.key});
  final Color color;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        const dashWidth = 5.0;
        const dashSpace = 4.0;
        final count = (constraints.maxWidth / (dashWidth + dashSpace)).floor();
        return Row(
          children: List.generate(
            count,
            (_) => Padding(
              padding: const EdgeInsets.only(left: dashSpace),
              child: Container(width: dashWidth, height: 1, color: color),
            ),
          ),
        );
      },
    );
  }
}
