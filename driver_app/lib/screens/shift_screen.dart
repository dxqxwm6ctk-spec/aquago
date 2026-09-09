import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/driver_chrome.dart';
import '../state/driver_state.dart';

/// شاشة "الوردية" — لوحة السائق الرئيسية: تشغيل/إيقاف استقبال الطلبات،
/// إحصائيات اليوم، تنبيه الطلب الجديد القريب، ومهام الوردية.
class ShiftScreen extends StatelessWidget {
  const ShiftScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();
    final colors = context.colors;

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _DriverHeader(),
              const SizedBox(height: 18),
              _ShiftToggleCard(),
              const SizedBox(height: 18),
              const _TodayStatsRow(),
              if (state.online) ...[
                const SizedBox(height: 18),
                const _NewOrderAlert(),
              ],
              const SizedBox(height: 18),
              _ShiftTasksCard(colors: colors),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const DriverBottomNav(),
    );
  }
}

class _DriverHeader extends StatelessWidget {
  const _DriverHeader();

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Row(
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(gradient: AquaColors.markGradient, borderRadius: BorderRadius.circular(14)),
          alignment: Alignment.center,
          child: Text('م', style: AquaText.arabic(size: 16, weight: FontWeight.w700, color: Colors.white)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(DriverState.driverName, style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: colors.ink)),
              Text(DriverState.driverPlate, style: AquaText.numeric(size: 12, weight: FontWeight.w500, color: colors.ink3)),
            ],
          ),
        ),
        Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: colors.surface,
                border: Border.all(color: colors.line),
                borderRadius: BorderRadius.circular(AquaRadii.sm),
              ),
              child: Icon(Icons.notifications_none_rounded, color: colors.deep, size: 20),
            ),
            Positioned(
              top: -2,
              left: -2,
              child: Container(
                width: 9,
                height: 9,
                decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle, border: Border.all(color: colors.surface, width: 1.5)),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _ShiftToggleCard extends StatelessWidget {
  const _ShiftToggleCard();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();
    final colors = context.colors;
    final online = state.online;

    return GestureDetector(
      onTap: state.toggleOnline,
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          gradient: online ? AquaColors.heroGradient : null,
          color: online ? null : colors.surface,
          border: online ? null : Border.all(color: colors.line),
          borderRadius: BorderRadius.circular(AquaRadii.card),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    online ? 'وردية نشطة' : 'غير متصل',
                    style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: online ? Colors.white : colors.ink),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    online ? 'تستقبل الطلبات القريبة الآن' : 'اضغط لبدء استلام الطلبات',
                    style: AquaText.arabic(size: 12.5, color: online ? colors.sky200 : colors.ink3),
                  ),
                ],
              ),
            ),
            AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              width: 54,
              height: 32,
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: online ? Colors.white.withValues(alpha: 0.32) : colors.line2,
                borderRadius: BorderRadius.circular(AquaRadii.pill),
              ),
              child: Align(
                alignment: online ? Alignment.centerLeft : Alignment.centerRight,
                child: Container(
                  width: 26,
                  height: 26,
                  decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TodayStatsRow extends StatelessWidget {
  const _TodayStatsRow();

  @override
  Widget build(BuildContext context) {
    Widget stat(String label, String value) => Expanded(
          child: AquaCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: AquaText.arabic(size: 11.5, color: context.colors.ink3)),
                const SizedBox(height: 6),
                Text(value, style: AquaText.numeric(size: 18, weight: FontWeight.w700, color: context.colors.ink)),
              ],
            ),
          ),
        );

    return Row(
      children: [
        stat('طلبات اليوم', DriverState.ordersToday),
        const SizedBox(width: 10),
        stat('أرباح اليوم', DriverState.earningsToday),
        const SizedBox(width: 10),
        stat('التقييم', DriverState.rating),
      ],
    );
  }
}

class _NewOrderAlert extends StatelessWidget {
  const _NewOrderAlert();

  @override
  Widget build(BuildContext context) {
    final state = context.read<DriverState>();
    final colors = context.colors;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const LiveDot(),
            const SizedBox(width: 8),
            Text('طلب جديد قريب منك', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
          ],
        ),
        const SizedBox(height: 10),
        AquaCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(DriverState.orderId, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: colors.ink3)),
                  const Spacer(),
                  StatusPill(label: DriverState.orderDistance, background: colors.infoBg, foreground: colors.infoFg),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(color: colors.sky100, borderRadius: BorderRadius.circular(AquaRadii.sm)),
                    child: Icon(Icons.water_drop_outlined, color: colors.deep, size: 20),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(DriverState.orderItems, style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
                        Text(DriverState.orderAddress, style: AquaText.arabic(size: 12, color: colors.ink3)),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                'نقدًا عند التسليم · ${DriverState.cashToCollect} د.أ',
                style: AquaText.arabic(size: 12.5, weight: FontWeight.w700, color: colors.teal),
              ),
              const SizedBox(height: 10),
              ClipRRect(
                borderRadius: BorderRadius.circular(99),
                child: LayoutBuilder(
                  builder: (context, constraints) => Stack(
                    children: [
                      Container(height: 6, color: colors.bg),
                      Container(
                        height: 6,
                        width: constraints.maxWidth * 0.42,
                        decoration: BoxDecoration(gradient: AquaColors.buttonGradient),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: GestureDetector(
                      onTap: state.acceptOffer,
                      child: Container(
                        height: 44,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(gradient: AquaColors.buttonGradient, borderRadius: BorderRadius.circular(AquaRadii.button)),
                        child: Text('قبول الطلب', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: Colors.white)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(border: Border.all(color: colors.line2), borderRadius: BorderRadius.circular(AquaRadii.button)),
                    child: Icon(Icons.close_rounded, color: colors.ink3),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ShiftTasksCard extends StatelessWidget {
  const _ShiftTasksCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    Widget row(String badge, String title, String sub) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Row(
            children: [
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: colors.sky100, borderRadius: BorderRadius.circular(AquaRadii.sm)),
                child: Text(badge, style: AquaText.numeric(size: 13, weight: FontWeight.w700, color: colors.deep)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
                    Text(sub, style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                  ],
                ),
              ),
            ],
          ),
        );

    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('مهام الوردية', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
          row('12', 'قوارير محمّلة في المركبة', 'آخر تحميل 7:40 ص'),
          row('6', 'قوارير فارغة للإرجاع للمستودع', 'تسليم قبل 6:00 م'),
        ],
      ),
    );
  }
}
