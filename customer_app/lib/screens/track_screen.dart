import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:latlong2/latlong.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../core/ui/aqua_map.dart';
import '../state/app_state.dart';

/// شاشة "تتبّع الطلب" — خريطة حيّة، مؤشّر مراحل التسليم الأربع (قابل
/// للنقر لمحاكاة التقدّم في هذا العرض)، وبيانات السائق.
class TrackScreen extends StatelessWidget {
  const TrackScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final colors = context.colors;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => state.setScreen(AppScreen.home),
                    icon: Icon(Icons.chevron_right_rounded, color: colors.ink),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('تتبّع الطلب', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
                      Text(AppState.activeOrderId, style: AquaText.numeric(size: 11.5, color: colors.ink3)),
                    ],
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
                    _TrackMap(colors: colors),
                    const SizedBox(height: 16),
                    _StepsCard(state: state, colors: colors),
                    const SizedBox(height: 16),
                    _DriverCard(colors: colors),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: const AppBottomNav(),
    );
  }
}

/// خريطة التتبّع الحيّ: موقع السائق ووجهته (عنوان الزبون) وخطّ المسار
/// بينهما. المواقع ثابتة في هذا العرض؛ عند الربط تأتي من بثّ الموقع
/// الحيّ للسائق عبر Socket.IO.
class _TrackMap extends StatelessWidget {
  const _TrackMap({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaMap(
      height: 172,
      center: const LatLng(32.0100, 35.8405), // منتصف الطريق بين الاثنين
      zoom: 13.2,
      route: const [AmmanCoords.sweileh, AmmanCoords.khalda],
      markers: [
        AquaMapMarker(
          point: AmmanCoords.sweileh,
          icon: Icons.local_shipping_rounded,
          color: colors.aqua,
        ),
        AquaMapMarker(
          point: AmmanCoords.khalda,
          icon: Icons.home_rounded,
          color: colors.deep,
        ),
      ],
      overlay: const MapBadge(label: 'على بعد 2.1 كم'),
    );
  }
}

class _StepsCard extends StatelessWidget {
  const _StepsCard({required this.state, required this.colors});
  final AppState state;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final stages = AppState.trackStages;
    return GestureDetector(
      onTap: state.advanceTrackStep,
      child: AquaCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < stages.length; i++)
              _StageRow(index: i, stage: stages[i], step: state.step, isLast: i == stages.length - 1, colors: colors),
          ],
        ),
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
  final TrackStage stage;
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

class _DriverCard extends StatelessWidget {
  const _DriverCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      gradient: AquaColors.heroGradient,
      child: Row(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.16), borderRadius: BorderRadius.circular(AquaRadii.sm)),
            child: const Icon(Icons.person_outline_rounded, color: Colors.white),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('محمد العتوم', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: Colors.white)),
                // رقم اللوحة مُحاط بعلامتَي LRI/PDI (U+2066/U+2069) لأن
                // مقاطعه تُقلَب داخل سياق RTL فيظهر "2718-43". تُكتب
                // هروبًا لا حرفيًا لتفادي تحذير محارف الاتجاه الخفية.
                Text(
                  'سائق Aqua Go · بيك أب \u{2066}43-2718\u{2069}',
                  style: AquaText.arabic(size: 11.5, color: colors.sky200),
                ),
              ],
            ),
          ),
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle),
            child: const Icon(Icons.call_rounded, color: Colors.white, size: 18),
          ),
        ],
      ),
    );
  }
}
