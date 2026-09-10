import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/catalog.dart';
import '../core/tracking_service.dart';
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
                      // رقم الطلب الفعلي لا ثابتاً: كان يُعرض `AQ-1042`
                      // نفسه مهما طلب الزبون. وبلا طلبٍ لا يُعرض رقم أصلاً.
                      if (state.activeOrder != null)
                        Text(state.activeOrder!.id, style: AquaText.numeric(size: 11.5, color: colors.ink3)),
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
                    if (state.tracking.statusNote != null) ...[
                      const SizedBox(height: 10),
                      // ملاحظة الخادم مع تغيّر الحالة: «جارٍ البحث عن سائق»،
                      // «تعذّر إيجاد سائق قريب». الزبون ينتظر بلا كلمة بدونها.
                      _StatusNote(text: state.tracking.statusNote!, colors: colors),
                    ],
                    const SizedBox(height: 16),
                    // البطاقة لا تُعرض قبل تعيين سائق: كانت تعرض «محمد
                    // العتوم» ورقم لوحةٍ ثابتَين منذ لحظة الطلب — فيظنّ
                    // الزبون أن سائقاً في طريقه ولم يُعيَّن أحد بعد.
                    if (state.tracking.order?.driverName != null)
                      _DriverCard(colors: colors, order: state.tracking.order!),
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

/// خريطة التتبّع الحيّ: موقع السائق الفعلي ووجهته وخطّ المسار بينهما.
///
/// الموقع يصل عبر `driver:location` من الخادم. قبل هذا كانت نقطتان ثابتتان
/// وشارةٌ مكتوبة نصّاً «على بعد 2.1 كم» لا تتغيّر مهما تحرّك السائق — خريطةٌ
/// تبدو حيّة وهي صورة.
class _TrackMap extends StatelessWidget {
  const _TrackMap({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final tracking = context.watch<AppState>().tracking;
    final driver = tracking.position?.point;

    // الوجهة من عنوان الزبون. موقع السائق يُعرض حين يصل فقط: علامةٌ في
    // موضعٍ مفترض أسوأ من غيابها — الزبون يصدّقها ويقيس عليها.
    const destination = AmmanCoords.khalda;

    return AquaMap(
      height: 172,
      center: destination,
      zoom: 13.2,
      followPoints: true,
      route: driver == null ? const [] : [driver, destination],
      markers: [
        if (driver != null)
          AquaMapMarker(
            point: driver,
            icon: Icons.local_shipping_rounded,
            color: colors.aqua,
          ),
        AquaMapMarker(
          point: destination,
          icon: Icons.home_rounded,
          color: colors.deep,
        ),
      ],
      overlay: _TrackBadge(tracking: tracking),
    );
  }
}

/// شارة فوق الخريطة: المسافة والوقت المتبقّي، أو حالة القناة حين لا موقع.
///
/// الحالة تُعلَن ولا تُبتلع: خريطةٌ ساكنة بلا كلمة تترك الزبون يحدس أهي
/// محدَّثة أم متجمّدة — وأسوأها أن تعرض آخر موقع وصل إلى الأبد وتبدو صحيحة.
class _TrackBadge extends StatelessWidget {
  const _TrackBadge({required this.tracking});

  final TrackingService tracking;

  @override
  Widget build(BuildContext context) {
    final position = tracking.position;

    final label = switch (tracking.status) {
      TrackingStatus.connecting => 'جارٍ الاتصال…',
      TrackingStatus.waitingForDriver => 'بانتظار موقع السائق',
      TrackingStatus.disconnected =>
        position == null ? (tracking.error ?? 'انقطع الاتصال') : 'آخر موقع معروف',
      TrackingStatus.idle => 'التتبّع غير نشط',
      TrackingStatus.live => _liveLabel(position!),
    };

    return MapBadge(label: label);
  }

  /// «على بعد 2.1 كم · 7 دقائق» — الرقمان من الخادم لا من التطبيق.
  String _liveLabel(DriverPosition p) {
    // التقادم يُقال صراحةً: البثّ دوري، فصمتٌ يتجاوز دقيقة يعني انقطاعاً
    // لم تعلنه القناة بعد (نفق، شبكة ضعيفة).
    if (tracking.isStale) return 'آخر موقع معروف';

    final parts = <String>[
      if (p.distanceKm != null) 'على بعد ${p.distanceKm} كم',
      if (p.etaMinutes != null) '${p.etaMinutes} دقيقة',
    ];
    if (parts.isEmpty) return 'السائق في الطريق';
    // المرور بالمستودع يفسّر طول الوقت رغم قرب المسافة.
    return '${parts.join(' · ')}${p.viaWarehouse ? ' (عبر المستودع)' : ''}';
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
      // **لا تقدّم يدوي بعد الآن.** كان الضغط يقدّم المرحلة لمحاكاة تقدّم
      // الطلب حين لم يكن ثمة خادم؛ الآن المرحلة تأتي من حالة الطلب الفعلية،
      // وضغطةٌ تُقدّمها كانت ستكذب على الزبون بمرحلةٍ لم تحدث.
      onTap: null,
      child: AquaCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < stages.length; i++)
              _StageRow(
                index: i,
                stage: stages[i],
                // المرحلة من الطلب حين يصل، ومن الحالة المحلية قبله: بين
                // الاشتراك وأول قراءة ثوانٍ لا يجوز أن تُعرض فيها المرحلة
                // الأولى لطلبٍ قد يكون في الطريق أصلاً.
                step: state.tracking.order?.stageIndex ?? state.step,
                isLast: i == stages.length - 1,
                colors: colors,
              ),
          ],
        ),
      ),
    );
  }
}

/// ملاحظة الخادم أسفل مؤشّر المراحل.
class _StatusNote extends StatelessWidget {
  const _StatusNote({required this.text, required this.colors});

  final String text;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: colors.infoBg,
        borderRadius: BorderRadius.circular(AquaRadii.sm),
      ),
      child: Text(
        text,
        style: AquaText.arabic(size: 12.5, color: colors.infoFg, height: 1.5),
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
  const _DriverCard({required this.colors, required this.order});

  final AquaColors colors;
  final Order order;

  /// يفتح تطبيق الهاتف على رقم السائق.
  ///
  /// الرقم يصل من الخادم مع الطلب بعد التعيين وحده — قبله لا بطاقة أصلاً.
  Future<void> _call() async {
    final phone = order.driverPhone;
    if (phone == null || phone.isEmpty) return;
    final uri = Uri(scheme: 'tel', path: phone);
    if (await canLaunchUrl(uri)) await launchUrl(uri);
  }

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
                Text(
                  order.driverName ?? 'سائق Aqua Go',
                  style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: Colors.white),
                ),
                Text(
                  'سائق Aqua Go',
                  style: AquaText.arabic(size: 11.5, color: colors.sky200),
                ),
              ],
            ),
          ),
          // زرّ الاتصال كان أيقونةً لا تفعل شيئاً — ويُخفى بلا رقم بدل أن
          // يَعِد باتصالٍ لا يقع.
          if (order.driverPhone?.isNotEmpty == true)
            GestureDetector(
              onTap: _call,
              behavior: HitTestBehavior.opaque,
              child: Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle),
                child: const Icon(Icons.call_rounded, color: Colors.white, size: 18),
              ),
            ),
        ],
      ),
    );
  }
}
