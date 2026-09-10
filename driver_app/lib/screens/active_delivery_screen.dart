import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:latlong2/latlong.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/driver_chrome.dart';
import '../core/ui/aqua_map.dart';
import '../state/driver_state.dart';

/// شاشة "التسليم الجاري" — ملاحة، مؤشّر مراحل التسليم الأربع، وعدّاد
/// القوارير الفارغة المسترجعة.
class ActiveDeliveryScreen extends StatelessWidget {
  const ActiveDeliveryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();
    final colors = context.colors;
    final order = state.currentOrder;
    if (order == null) {
      // لا طلب مفتوح ⇐ رسالةٌ لا شاشةٌ بيضاء: الطلب قد يكون سُلّم للتوّ أو
      // ألغاه الزبون، والسائق يحتاج أن يعرف لا أن يحدس.
      return Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.inbox_outlined, size: 40, color: colors.ink4),
                  const SizedBox(height: 12),
                  Text(
                    'لا طلب مفتوح الآن',
                    style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'ستصلك العروض ما دامت ورديتك مفتوحة.',
                    textAlign: TextAlign.center,
                    style: AquaText.arabic(size: 12.5, color: colors.ink3),
                  ),
                  const SizedBox(height: 16),
                  GestureDetector(
                    onTap: () => state.setScreen(DriverScreen.shift),
                    behavior: HitTestBehavior.opaque,
                    child: Text(
                      'العودة إلى الوردية',
                      style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.deep),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        bottomNavigationBar: const DriverBottomNav(),
      );
    }
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => state.setScreen(DriverScreen.detail),
                    icon: Icon(Icons.chevron_right_rounded, color: colors.ink),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('التسليم الجاري', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
                        Text(order.code, style: AquaText.numeric(size: 11.5, color: colors.ink3)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _NavMap(colors: colors),
                    const SizedBox(height: 18),
                    _StepsTimeline(state: state, colors: colors),
                    const SizedBox(height: 16),
                    _EmptiesCounter(state: state, colors: colors),
                  ],
                ),
              ),
            ),
            DriverCtaBar(
              label: state.isLastStep ? 'إنهاء الطلب' : 'الخطوة التالية',
              onTap: state.busy ? null : state.advanceOrder,
            ),
          ],
        ),
      ),
      bottomNavigationBar: const DriverBottomNav(),
    );
  }
}

/// خريطة الملاحة أثناء التسليم: المسار إلى العميل، مع شريط التعليمة
/// التالية أعلاها ووقت الوصول أسفلها.
///
/// التعليمة ("انعطف يسارًا") ثابتة هنا: الملاحة خطوة‑بخطوة تحتاج
/// مزوّد توجيه (routing) لا مجرّد بلاطات خريطة، وهو قرار مؤجَّل مع
/// اختيار مزوّد البلاطات نفسه — انظر ملاحظة `AquaMap`.
class _NavMap extends StatelessWidget {
  const _NavMap({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaMap(
      height: 190,
      center: const LatLng(31.9985, 35.8445),
      zoom: 14,
      route: const [AmmanCoords.sweileh, AmmanCoords.khalda],
      markers: [
        AquaMapMarker(point: AmmanCoords.khalda, icon: Icons.person_pin_circle_rounded, color: colors.deep),
      ],
      overlay: Stack(
        children: [
          Positioned(
            top: 10,
            left: 10,
            right: 10,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(color: colors.deep, borderRadius: BorderRadius.circular(AquaRadii.md)),
              child: Row(
                children: [
                  const Icon(Icons.turn_left_rounded, color: Colors.white, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'انعطف يسارًا — شارع وصفي التل',
                      style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: Colors.white),
                    ),
                  ),
                  Text('400 م', style: AquaText.numeric(size: 12, weight: FontWeight.w600, color: Colors.white)),
                ],
              ),
            ),
          ),
          Positioned(
            bottom: 10,
            right: 10,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(color: colors.surface, borderRadius: BorderRadius.circular(AquaRadii.pill)),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(width: 8, height: 8, decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle)),
                  const SizedBox(width: 6),
                  Text('الوصول 8:33 ص', style: AquaText.numeric(size: 12, weight: FontWeight.w600, color: colors.ink)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StepsTimeline extends StatelessWidget {
  const _StepsTimeline({required this.state, required this.colors});
  final DriverState state;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final stages = DriverState.stages;
    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < stages.length; i++)
            // المرحلة من حالة الطلب على الخادم لا من عدّادٍ محلي: كان
            // التقدّم بضغطةٍ في التطبيق وحده، فيرى السائق «تم التسليم»
            // وحالةُ الطلب لم تتغيّر، والزبون ينتظر شاحنةً وصلت.
            _StageRow(
              index: i,
              stage: stages[i],
              step: state.currentOrder?.stageIndex ?? 0,
              isLast: i == stages.length - 1,
              colors: colors,
            ),
        ],
      ),
    );
  }
}

class _StageRow extends StatelessWidget {
  const _StageRow({
    required this.index,
    required this.stage,
    required this.step,
    required this.isLast,
    required this.colors,
  });

  final int index;
  final DeliveryStage stage;
  final int step;
  final bool isLast;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final done = index < step;
    final current = index == step;
    final dotColor = done ? colors.deep : (current ? colors.aqua : Colors.white);
    final ringColor = done ? colors.deep : (current ? colors.aqua : colors.line);
    final lineColor = isLast ? Colors.transparent : (done ? colors.deep : colors.line);
    final textColor = (done || current) ? colors.ink : colors.ink3;

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle, border: Border.all(color: ringColor, width: 2)),
              ),
              Expanded(child: Container(width: 2, color: lineColor)),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(child: Text(stage.label, style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: textColor))),
                  Text(stage.time, style: AquaText.numeric(size: 11.5, color: colors.ink3)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptiesCounter extends StatelessWidget {
  const _EmptiesCounter({required this.state, required this.colors});
  final DriverState state;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('قوارير فارغة مسترجعة', style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
                Text('سجّل العدد قبل إنهاء التسليم', style: AquaText.arabic(size: 11.5, color: colors.ink3)),
              ],
            ),
          ),
          _StepBtn(icon: Icons.remove, filled: false, onTap: state.decEmpties, colors: colors),
          SizedBox(
            width: 40,
            child: Text(
              '${state.empties}',
              textAlign: TextAlign.center,
              style: AquaText.numeric(size: 17, weight: FontWeight.w700, color: colors.ink),
            ),
          ),
          _StepBtn(icon: Icons.add, filled: true, onTap: state.incEmpties, colors: colors),
        ],
      ),
    );
  }
}

class _StepBtn extends StatelessWidget {
  const _StepBtn({required this.icon, required this.filled, required this.onTap, required this.colors});
  final IconData icon;
  final bool filled;
  final VoidCallback onTap;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 34,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          gradient: filled ? AquaColors.buttonGradient : null,
          border: filled ? null : Border.all(color: colors.line2, width: 1.5),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, size: 16, color: filled ? Colors.white : colors.ink2),
      ),
    );
  }
}
