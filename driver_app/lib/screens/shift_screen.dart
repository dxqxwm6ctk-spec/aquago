import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/driver_chrome.dart';
import '../core/location_broadcast.dart';
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
              if (state.online && state.offer != null) ...[
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
    final name = context.watch<DriverState>().driverName;
    return Row(
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(gradient: AquaColors.markGradient, borderRadius: BorderRadius.circular(14)),
          alignment: Alignment.center,
          // أول حرف من اسمه هو لا حرفٌ ثابت — الحساب صار حقيقياً.
          child: Text(
            name.characters.isEmpty ? '؟' : name.characters.first,
            style: AquaText.arabic(size: 16, weight: FontWeight.w700, color: Colors.white),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: colors.ink)),
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

  /// النص تحت «وردية نشطة» — يقول الحقيقة عن الموقع.
  ///
  /// كان «تستقبل الطلبات القريبة الآن» ثابتاً: سائقٌ رفض إذن الموقع يقرأه
  /// ويطمئن، بينما موقعه لا يصل ولا زبونَ يراه على الخريطة.
  static String _broadcastLabel(BroadcastStatus s) => switch (s) {
        BroadcastStatus.live => 'تستقبل الطلبات — موقعك يصل للزبائن',
        BroadcastStatus.starting => 'جارٍ تشغيل التتبّع…',
        BroadcastStatus.permissionDenied => 'إذن الموقع مرفوض — التتبّع معطّل',
        BroadcastStatus.permissionDeniedForever =>
          'فعّل إذن الموقع من إعدادات النظام',
        BroadcastStatus.locationServiceOff => 'خدمة الموقع مطفأة على جهازك',
        BroadcastStatus.disconnected => 'انقطع الاتصال — موقعك لا يصل',
        BroadcastStatus.off => 'تستقبل الطلبات القريبة الآن',
      };

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
                    online
                        ? _broadcastLabel(state.location.status)
                        : 'اضغط لبدء استلام الطلبات',
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

    final stats = context.watch<DriverState>().stats;

    // **«أرباح اليوم» حُذفت لا نُقلت.** الخادم لا يحمل رقماً لأجر السائق —
    // تحاسبه وكالته لا المنصة (`/driver/stats` تردّ توصيلات وتقييماً فقط).
    // كان يُعرض «18.750» مخترعاً، وأخطر ما في تطبيقٍ أن يَعِد سائقاً بمبلغ
    // لا مصدر له. إجمالي التوصيلات مكانها: رقمٌ حقيقي ويعني شيئاً له.
    return Row(
      children: [
        stat('توصيلات اليوم', '${stats?.completedToday ?? 0}'),
        const SizedBox(width: 10),
        stat('إجمالي التوصيلات', '${stats?.completedTotal ?? 0}'),
        const SizedBox(width: 10),
        stat('التقييم', stats?.ratingLabel ?? '—'),
      ],
    );
  }
}

/// بطاقة العرض المعلّق — تظهر حين يصل عرضٌ فعلي وحدها.
///
/// كانت تُعرض دائماً ما دامت الوردية مفتوحة، ببيانات ثابتة: طلبٌ لا وجود له،
/// وضغطةُ «قبول» تنقل الشاشة ولا تُخبر الخادم بشيء.
class _NewOrderAlert extends StatelessWidget {
  const _NewOrderAlert();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<DriverState>();
    final offer = state.offer;
    final colors = context.colors;

    if (offer == null) return const SizedBox.shrink();

    final order = offer.order;
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
                  Text(order.code, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: colors.ink3)),
                  const Spacer(),
                  if (offer.zone != null)
                    StatusPill(label: offer.zone!, background: colors.infoBg, foreground: colors.infoFg),
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
                        Text(order.itemsLabel, style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
                        Text(order.addressText, style: AquaText.arabic(size: 12, color: colors.ink3)),
                      ],
                    ),
                  ),
                ],
              ),
              if (order.total != null) ...[
                const SizedBox(height: 10),
                Text(
                  'نقدًا عند التسليم · ${order.total!.toStringAsFixed(3)} د.أ',
                  style: AquaText.arabic(size: 12.5, weight: FontWeight.w700, color: colors.teal),
                ),
              ],
              const SizedBox(height: 10),
              _OfferCountdown(seconds: offer.remainingSeconds, colors: colors),
              if (state.actionError != null) ...[
                const SizedBox(height: 8),
                Text(
                  state.actionError!,
                  style: AquaText.arabic(size: 12, color: colors.dangerFg),
                ),
              ],
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: GestureDetector(
                      onTap: state.busy ? null : state.acceptOffer,
                      behavior: HitTestBehavior.opaque,
                      child: Container(
                        height: 44,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(gradient: AquaColors.buttonGradient, borderRadius: BorderRadius.circular(AquaRadii.button)),
                        child: state.busy
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  valueColor: AlwaysStoppedAnimation(Colors.white),
                                ),
                              )
                            : Text('قبول الطلب', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: Colors.white)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  // زرّ الرفض كان أيقونةً لا تفعل شيئاً: يبقى العرض معروضاً
                  // ويمضي مؤقّته، ولا يعرف الخادم أن السائق لا يريده فيؤخّر
                  // عرضه على غيره.
                  GestureDetector(
                    onTap: state.busy ? null : state.rejectOffer,
                    behavior: HitTestBehavior.opaque,
                    child: Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(border: Border.all(color: colors.line2), borderRadius: BorderRadius.circular(AquaRadii.button)),
                      child: Icon(Icons.close_rounded, color: colors.ink3),
                    ),
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

/// شريط المؤقّت التنازلي للعرض.
///
/// الثواني من الخادم لا من `expiresAt`: ساعةُ الجهاز قد تكون مضبوطة خطأً،
/// فمؤقّتٌ مبنيّ على وقتها ينتهي مبكّراً أو يتأخّر بفارق ساعة كاملة.
class _OfferCountdown extends StatefulWidget {
  const _OfferCountdown({required this.seconds, required this.colors});

  final int seconds;
  final AquaColors colors;

  @override
  State<_OfferCountdown> createState() => _OfferCountdownState();
}

class _OfferCountdownState extends State<_OfferCountdown> {
  late int _left = widget.seconds;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(_OfferCountdown old) {
    super.didUpdateWidget(old);
    // عرضٌ جديد ⇐ مؤقّت جديد: بلا هذا كان الشريط يكمل عدّ العرض السابق.
    if (old.seconds != widget.seconds) {
      _left = widget.seconds;
      _start();
    }
  }

  void _start() {
    _timer?.cancel();
    if (_left <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _left = _left > 0 ? _left - 1 : 0);
      if (_left <= 0) t.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.seconds == 0 ? 1 : widget.seconds;
    final colors = widget.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: LayoutBuilder(
            builder: (context, constraints) => Stack(
              children: [
                Container(height: 6, color: colors.bg),
                Container(
                  height: 6,
                  width: constraints.maxWidth * (_left / total).clamp(0.0, 1.0),
                  decoration: BoxDecoration(gradient: AquaColors.buttonGradient),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          _left > 0 ? 'يتبقّى $_left ثانية للردّ' : 'انتهت مهلة العرض',
          style: AquaText.arabic(size: 11.5, color: _left > 0 ? colors.ink3 : colors.dangerFg),
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
