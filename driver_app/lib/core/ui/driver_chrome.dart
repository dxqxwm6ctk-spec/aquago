import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../theme/aqua_theme.dart';
import '../theme/aqua_colors.dart';
import '../theme/aqua_text.dart';
import '../../state/driver_state.dart';

/// عناصر الواجهة المشتركة بين شاشات تطبيق السائق الأربع: الشريط
/// السفلي الثابت (4 تبويبات)، وشريط الإجراء السفلي الاختياري (CTA).

class _NavItem {
  const _NavItem(this.screen, this.label, this.icon);
  final DriverScreen screen;
  final String label;
  final IconData icon;
}

const _navItems = [
  _NavItem(DriverScreen.shift, 'الوردية', Icons.home_rounded),
  _NavItem(DriverScreen.detail, 'الطلبات', Icons.assignment_outlined),
  _NavItem(DriverScreen.run, 'التوصيل', Icons.location_on_outlined),
  _NavItem(DriverScreen.earn, 'سجلّي', Icons.receipt_long_outlined),
];

/// الشريط السفلي الثابت — 4 تبويبات، يتلوّن التبويب النشط بلون العلامة
/// الداكن (`deep`) والبقية بالرمادي (`ink3`)، طبقًا للتصميم الأصلي.
class DriverBottomNav extends StatelessWidget {
  const DriverBottomNav({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();
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

/// شريط الإجراء السفلي الاختياري: مبلغ التحصيل الثابت (5.250) على
/// اليمين، وزر إجراء متدرّج على اليسار (متن ملطّي يمثّل مساره).
class DriverCtaBar extends StatelessWidget {
  const DriverCtaBar({required this.label, required this.onTap, super.key});

  final String label;

  /// `null` يُعطّل الزرّ — أثناء إرسال الطلب إلى الخادم مثلاً.
  ///
  /// زرٌّ يستجيب بلا أثر يدفع السائق إلى الضغط مراراً وهو يظنّ أن شيئاً لم
  /// يحدث، وكلُّ ضغطةٍ نداءٌ آخر إلى الخادم.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
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
              Text('تحصيل', style: AquaText.arabic(size: 11.5, color: colors.ink3)),
              Text(
                // المبلغ من الطلب الفعلي: كان «5.250» ثابتاً مهما كان الطلب،
                // وهو رقمٌ يقبض به السائق من الزبون.
                context.watch<DriverState>().currentOrder?.total?.toStringAsFixed(3) ?? '—',
                style: AquaText.numeric(size: 15, weight: FontWeight.w700, color: colors.ink),
              ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: GestureDetector(
              onTap: onTap,
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
                    Text(
                      label,
                      style: AquaText.arabic(size: 14.5, weight: FontWeight.w700, color: Colors.white),
                    ),
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

/// نقطة نبض حيّة (ripple) — تُستخدم بجانب تنبيه "طلب جديد قريب منك".
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

/// شارة حالة نصية بخلفية ملوّنة (مقبول/في الطريق/مسلّم/ملغي...).
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
