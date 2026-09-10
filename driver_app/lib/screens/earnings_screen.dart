import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/driver_models.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/theme/aqua_theme.dart';
import '../core/ui/driver_chrome.dart';
import '../state/driver_state.dart';

/// شاشة "سجلّ التوصيلات" — التوصيلات المكتملة والتقييم وسجلّ الطلبات.
///
/// **كانت «الأرباح»، وحُذفت أرقامها لا نُقلت.** عرضت «96.500 هذا الأسبوع»
/// و«42.000 نقد للتوريد» وأعمدةً بيانية — كلها ثوابت في الكود. والخادم لا
/// يحمل رقماً لأجر السائق أصلاً: تحاسبه وكالته لا المنصة، و`/driver/stats`
/// تردّ عدد التوصيلات والتقييم فقط.
///
/// أخطر ما في تطبيقٍ أن يَعِد سائقاً بمبلغٍ لا مصدر له: يبني عليه، ثم يجد
/// وكالته تحاسبه بغيره. ما يعرفه الخادم يُعرض، وما لا يعرفه لا يُخترَع.
class EarningsScreen extends StatelessWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final state = context.watch<DriverState>();

    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: state.loadDriverData,
          child: SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('سجلّ التوصيلات', style: AquaText.arabic(size: 22, weight: FontWeight.w700, color: colors.ink)),
                const SizedBox(height: 16),
                _SummaryCard(colors: colors, stats: state.stats),
                const SizedBox(height: 16),
                Text('طلباتك الأخيرة', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
                const SizedBox(height: 10),
                _HistoryCard(colors: colors, orders: state.orders),
                if (state.dataError != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    state.dataError!,
                    style: AquaText.arabic(size: 12, color: colors.dangerFg),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
      bottomNavigationBar: const DriverBottomNav(),
    );
  }
}

/// بطاقة الملخّص: توصيلات اليوم والإجمالي والتقييم.
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.colors, required this.stats});

  final AquaColors colors;
  final DriverStats? stats;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: const EdgeInsets.all(20),
      gradient: AquaColors.heroGradient,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('توصيلاتك حتى الآن', style: AquaText.arabic(size: 12.5, color: colors.sky200)),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                '${stats?.completedTotal ?? 0}',
                style: AquaText.numeric(size: 27, weight: FontWeight.w700, color: Colors.white),
              ),
              const SizedBox(width: 6),
              Text('طلب', style: AquaText.arabic(size: 13, weight: FontWeight.w500, color: colors.sky200)),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              _MiniStat(
                label: 'اليوم',
                value: '${stats?.completedToday ?? 0}',
                colors: colors,
              ),
              const SizedBox(width: 24),
              _MiniStat(
                label: 'التقييم',
                // «—» لا «0.0» قبل أول تقييم: الصفر يبدو تقييماً سيئاً وهو
                // غيابُ تقييمٍ أصلاً.
                value: stats?.ratingLabel ?? '—',
                colors: colors,
              ),
              if ((stats?.ratingCount ?? 0) > 0) ...[
                const SizedBox(width: 24),
                _MiniStat(
                  label: 'عدد المُقيّمين',
                  value: '${stats!.ratingCount}',
                  colors: colors,
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({
    required this.label,
    required this.value,
    required this.colors,
  });

  final String label;
  final String value;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: AquaText.arabic(size: 11.5, color: colors.sky200)),
        const SizedBox(height: 4),
        Text(value, style: AquaText.numeric(size: 17, weight: FontWeight.w700, color: Colors.white)),
      ],
    );
  }
}

/// سجلّ الطلبات — من `/driver/orders` (آخر خمسين).
class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.colors, required this.orders});

  final AquaColors colors;
  final List<DriverOrder> orders;

  /// وصفٌ عربي لحالة الطلب — الحالات الخام لا تُعرض للسائق.
  (String, bool) _statusOf(String status) => switch (status) {
        'COMPLETED' => ('مسلّم', true),
        'CANCELLED' => ('ملغى', false),
        'DRIVER_ASSIGNED' => ('بانتظار التحميل', true),
        'PICKED_UP' => ('محمّل', true),
        'DELIVERING' => ('في الطريق', true),
        _ => (status, true),
      };

  @override
  Widget build(BuildContext context) {
    if (orders.isEmpty) {
      return AquaCard(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 18),
          child: Text(
            'لا طلبات بعد — ستظهر هنا بعد أول توصيلة.',
            textAlign: TextAlign.center,
            style: AquaText.arabic(size: 12.5, color: colors.ink3),
          ),
        ),
      );
    }

    return AquaCard(
      child: Column(
        children: [
          for (var i = 0; i < orders.length; i++) ...[
            if (i > 0) Divider(color: colors.line, height: 20),
            _HistoryRow(order: orders[i], colors: colors, statusOf: _statusOf),
          ],
        ],
      ),
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({
    required this.order,
    required this.colors,
    required this.statusOf,
  });

  final DriverOrder order;
  final AquaColors colors;
  final (String, bool) Function(String) statusOf;

  @override
  Widget build(BuildContext context) {
    final (label, ok) = statusOf(order.status);
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(order.code, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: colors.ink)),
              const SizedBox(height: 2),
              Text(
                order.addressText.isEmpty ? order.itemsLabel : order.addressText,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AquaText.arabic(size: 11.5, color: colors.ink3),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        StatusPill(
          label: label,
          background: ok ? colors.successBg : colors.dangerBg,
          foreground: ok ? colors.successFg : colors.dangerFg,
        ),
      ],
    );
  }
}
