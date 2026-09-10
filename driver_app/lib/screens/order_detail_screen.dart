import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:latlong2/latlong.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/driver_chrome.dart';
import '../core/ui/aqua_map.dart';
import '../state/driver_state.dart';

/// شاشة "تفاصيل الطلب" — مراجعة بيانات العميل والمحتوى والمبلغ قبل
/// الانطلاق، مع تذكير باسترجاع القوارير الفارغة.
class OrderDetailScreen extends StatelessWidget {
  const OrderDetailScreen({super.key});

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
                    onPressed: () => state.setScreen(DriverScreen.shift),
                    icon: Icon(Icons.chevron_right_rounded, color: colors.ink),
                  ),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('تفاصيل الطلب', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
                        Text(order.code, style: AquaText.numeric(size: 11.5, color: colors.ink3)),
                      ],
                    ),
                  ),
                  StatusPill(label: 'مقبول', background: colors.infoBg, foreground: colors.infoFg),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _RouteMap(colors: colors),
                    const SizedBox(height: 16),
                    _CustomerCard(colors: colors),
                    const SizedBox(height: 16),
                    _OrderContentsCard(colors: colors),
                    const SizedBox(height: 16),
                    _InfoBanner(colors: colors),
                  ],
                ),
              ),
            ),
            // نصّ الزرّ من حالة الطلب: «حمّلت القوارير» ثم «انطلقت للزبون»
            // ثم «تم التسليم». زرٌّ ثابت النصّ كان يَعِد ببدءٍ وقد بدأ فعلاً.
            DriverCtaBar(
              label: order.nextActionLabel ?? 'بدء التوصيل',
              onTap: state.busy ? null : state.startDelivery,
            ),
          ],
        ),
      ),
      bottomNavigationBar: const DriverBottomNav(),
    );
  }
}

/// خريطة المسار: من موقع السائق (المستودع) إلى عنوان العميل، مع
/// المسافة والزمن المقدَّر. المواقع ثابتة في هذا العرض؛ عند الربط
/// تأتي من `location` في الطلب وموقع السائق الحيّ.
class _RouteMap extends StatelessWidget {
  const _RouteMap({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final order = context.watch<DriverState>().currentOrder;
    if (order == null) return const SizedBox.shrink();
    return AquaMap(
      height: 150,
      center: const LatLng(32.0100, 35.8405),
      zoom: 13.2,
      route: const [AmmanCoords.sweileh, AmmanCoords.khalda],
      markers: [
        AquaMapMarker(point: AmmanCoords.sweileh, icon: Icons.local_shipping_rounded, color: colors.aqua),
        AquaMapMarker(point: AmmanCoords.khalda, icon: Icons.person_pin_circle_rounded, color: colors.deep),
      ],
      overlay: MapBadge(label: order.addressText, showDot: false),
    );
  }
}

class _CustomerCard extends StatelessWidget {
  const _CustomerCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final order = context.watch<DriverState>().currentOrder;
    if (order == null) return const SizedBox.shrink();
    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('العميل', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.ink)),
          const SizedBox(height: 10),
          Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(gradient: AquaColors.markGradient, borderRadius: BorderRadius.circular(AquaRadii.sm)),
                alignment: Alignment.center,
                child: Text('ا', style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: Colors.white)),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(order.customerName ?? 'زبون AquaGo', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
                    Text('خلدا · بناية 24، طابق 3', style: AquaText.arabic(size: 12, color: colors.ink3)),
                  ],
                ),
              ),
              _RoundIconButton(icon: Icons.call_rounded, filled: true, colors: colors),
              const SizedBox(width: 8),
              _RoundIconButton(icon: Icons.mail_outline_rounded, filled: false, colors: colors),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: colors.bg2, borderRadius: BorderRadius.circular(AquaRadii.sm)),
            child: Text(
              'ملاحظة العميل: «${order.notes ?? 'لا ملاحظات'}»',
              style: AquaText.arabic(size: 12.5, color: colors.ink2, height: 1.6),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoundIconButton extends StatelessWidget {
  const _RoundIconButton({required this.icon, required this.filled, required this.colors});
  final IconData icon;
  final bool filled;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        color: filled ? colors.deep : colors.sky100,
        borderRadius: BorderRadius.circular(AquaRadii.sm),
      ),
      child: Icon(icon, size: 18, color: filled ? Colors.white : colors.deep),
    );
  }
}

class _OrderContentsCard extends StatelessWidget {
  const _OrderContentsCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final order = context.watch<DriverState>().currentOrder;
    if (order == null) return const SizedBox.shrink();
    Widget line(String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: AquaText.arabic(size: 13.5, color: colors.ink2)),
              Text(value, style: AquaText.numeric(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
            ],
          ),
        );

    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('محتوى الطلب', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.ink)),
          const SizedBox(height: 6),
          line(order.itemsLabel, order.total?.toStringAsFixed(3) ?? '—'),
          line('رسوم التوصيل', '0.250'),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: DottedDivider(color: colors.line),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('تحصيل نقدي', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
              Row(
                children: [
                  Text(order.total?.toStringAsFixed(3) ?? '—', style: AquaText.numeric(size: 18, weight: FontWeight.w700, color: colors.deep)),
                  const SizedBox(width: 4),
                  Text('JOD', style: AquaText.numeric(size: 12, weight: FontWeight.w500, color: colors.ink3)),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _InfoBanner extends StatelessWidget {
  const _InfoBanner({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.sky050,
        border: Border.all(color: colors.sky200),
        borderRadius: BorderRadius.circular(AquaRadii.md),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline_rounded, size: 18, color: colors.deep),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'استرجع القوارير الفارغة وسجّل العدد عند التسليم.',
              style: AquaText.arabic(size: 12, color: colors.deep, height: 1.5),
            ),
          ),
        ],
      ),
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
