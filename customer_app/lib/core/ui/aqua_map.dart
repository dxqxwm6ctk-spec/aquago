import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import '../theme/aqua_theme.dart';
import '../theme/aqua_colors.dart';
import '../theme/aqua_text.dart';

/// إحداثيات مناطق عمّان المستخدمة في بيانات العرض — تقريبية ومقصودة
/// للعرض فقط. عند الربط بالخادم تأتي من حقل `location` (PostGIS) في
/// الطلب والسائق، لا من ثابت هنا.
class AmmanCoords {
  AmmanCoords._();

  static const khalda = LatLng(31.9930, 35.8480); // خلدا — عنوان الزبون
  static const sweileh = LatLng(32.0270, 35.8330); // صويلح — المستودع
  static const tlaAlAli = LatLng(31.9880, 35.8700); // تلاع العلي
  static const rabiah = LatLng(31.9760, 35.8770); // الرابية

  /// مركز افتراضي يغطّي مناطق التغطية الحالية.
  static const center = LatLng(31.9990, 35.8560);
}

/// خريطة AquaGo — `flutter_map` فوق بلاطات OpenStreetMap، لا خرائط
/// Google (التكلفة والقيود — SKILL.md §5).
///
/// نسخ متعمَّد بين customer_app وdriver_app: الملفان متطابقان عمدًا،
/// لأن حزمة مشتركة تُجبر التطبيقين على التغيّر معًا. ما يجب أن يبقى
/// متطابقًا حقًّا (رابط البلاطات و`userAgentPackageName`) مذكور هنا
/// بالاسم نفسه في الملفَّين.
///
/// ⚠️ بلاطات OSM العامّة مسموحة للتطوير والحجم الخفيف فقط؛ سياسة
/// استخدامها تمنع الإنتاج التجاري بلا اتفاق. قبل النشر يُستبدل
/// `_tileUrl` بمزوّد متعاقَد عليه (MapTiler/Stadia أو خادم بلاطات
/// ذاتي) — القرار يبقى مؤجَّلًا لا منسيًّا.
class AquaMap extends StatelessWidget {
  const AquaMap({
    required this.height,
    this.center = AmmanCoords.center,
    this.zoom = 13,
    this.markers = const [],
    this.route = const [],
    this.overlay,
    super.key,
  });

  final double height;
  final LatLng center;
  final double zoom;
  final List<AquaMapMarker> markers;

  /// مسار يُرسم خطًّا بين نقطتين أو أكثر (طريق السائق إلى العميل).
  final List<LatLng> route;

  /// عنصر يُركَّب فوق الخريطة (شارة المسافة، تعليمات الاتجاه...).
  final Widget? overlay;

  static const _tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  static const _userAgent = 'jo.aquago.customer_app';

  /// تُعطَّل طبقة البلاطات داخل اختبارات الودجت.
  ///
  /// بيئة الاختبار تردّ 400 على كل طلب شبكة، فتُسجَّل استثناءات
  /// `ClientException` **بعد** انتهاء الاختبار (غير متزامنة، لا يلتقطها
  /// `takeException`) فيفشل اختبارٌ لا علاقة له بالشبكة. وعددها يكبر
  /// كلما اتّسع إطار الخريطة، فالفشل يظهر ويختفي بتغييرات لا صلة لها به.
  ///
  /// ما يقيسه الاختبار هو أن الخريطة حقيقية (`FlutterMap` وعلاماتها)
  /// لا أن البلاطات تُنزَّل — وذاك يُتحقَّق منه على الجهاز بلقطة شاشة.
  static bool get _inWidgetTest =>
      Platform.environment.containsKey('FLUTTER_TEST');

  /// النقاط التي يجب أن يسعها الإطار: المسار وكل العلامات.
  List<LatLng> get _fitPoints => [...route, ...markers.map((m) => m.point)];

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return SizedBox(
      height: height,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AquaRadii.card),
        child: Stack(
          children: [
            // خلفية بلون العلامة تحت البلاطات: انقطاع الشبكة يترك
            // `FlutterMap` فراغًا أبيض تبدو معه البطاقة معطوبة، بينما
            // هذه تُبقيها مقصودة المظهر والعلامات والمسار فوقها
            // مقروءَين — فالمستخدم يرى موقعه لا خطأً.
            Positioned.fill(child: ColoredBox(color: colors.sky100)),
            FlutterMap(
              options: MapOptions(
                initialCenter: center,
                initialZoom: zoom,
                // حين تُعطى نقاطٌ (مسار أو علامات) يُحسب الإطار منها بدل
                // مركزٍ وتقريبٍ ثابتَين: البطاقة هنا 172px ارتفاعًا، وعند
                // تقريبٍ محسوبٍ باليد كان طرفا المسار — السائق والبيت —
                // يقعان خارج الإطار، فيرى الزبون خطًّا بلا طرفَين.
                // `padding` يمنع لصق العلامة بالحافة فتُقصّ نصفها.
                initialCameraFit: _fitPoints.isEmpty
                    ? null
                    : CameraFit.coordinates(
                        coordinates: _fitPoints,
                        padding: const EdgeInsets.all(36),
                        maxZoom: 15,
                      ),
                // الخريطة هنا عرضٌ لا أداةُ استكشاف: التمرير داخلها
                // يسرق إيماءة تمرير الصفحة، فيُكتفى بالتكبير والسحب
                // المحدودَين ضمن حدود عمّان.
                interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.pinchZoom | InteractiveFlag.drag,
                ),
              ),
              children: [
                if (!_inWidgetTest)
                  TileLayer(urlTemplate: _tileUrl, userAgentPackageName: _userAgent),
                if (route.length > 1)
                  PolylineLayer(
                    polylines: [
                      Polyline(points: route, strokeWidth: 4, color: colors.deep),
                    ],
                  ),
                if (markers.isNotEmpty)
                  MarkerLayer(
                    markers: [
                      for (final m in markers)
                        Marker(
                          point: m.point,
                          width: 40,
                          height: 40,
                          child: _MarkerPin(marker: m, colors: colors),
                        ),
                    ],
                  ),
              ],
            ),
            ?overlay,
          ],
        ),
      ),
    );
  }
}

/// علامة على الخريطة: نقطة + أيقونة ولون.
class AquaMapMarker {
  const AquaMapMarker({
    required this.point,
    required this.icon,
    this.color,
  });

  final LatLng point;
  final IconData icon;
  final Color? color;
}

class _MarkerPin extends StatelessWidget {
  const _MarkerPin({required this.marker, required this.colors});
  final AquaMapMarker marker;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final color = marker.color ?? colors.deep;
    return Container(
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2.5),
        boxShadow: [
          BoxShadow(
            color: colors.ink.withValues(alpha: 0.3),
            blurRadius: 8,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Icon(marker.icon, color: Colors.white, size: 18),
    );
  }
}

/// شارة تُركَّب على الخريطة (المسافة، وقت الوصول...).
class MapBadge extends StatelessWidget {
  const MapBadge({
    required this.label,
    this.alignment = Alignment.bottomLeft,
    this.showDot = true,
    super.key,
  });

  final String label;
  final Alignment alignment;
  final bool showDot;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Align(
      alignment: alignment,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            color: colors.deep,
            borderRadius: BorderRadius.circular(AquaRadii.pill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (showDot) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: AquaText.arabic(size: 12, weight: FontWeight.w600, color: Colors.white),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
