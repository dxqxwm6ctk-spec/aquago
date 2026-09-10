import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';
import 'address_sheet.dart';

/// شاشة "تأكيد الطلب" — عنوان التسليم، وقت التوصيل (الآن/مجدول)،
/// ملخّص الطلب والسعر، وطريقة الدفع.
class CheckoutScreen extends StatelessWidget {
  const CheckoutScreen({super.key});

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
                    onPressed: () => state.setScreen(AppScreen.order),
                    icon: Icon(Icons.chevron_right_rounded, color: colors.ink),
                  ),
                  Text('تأكيد الطلب', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _StepProgress(colors: colors),
                    const SizedBox(height: 18),
                    _AddressCard(colors: colors),
                    const SizedBox(height: 14),
                    _DeliveryTimeCard(state: state, colors: colors),
                    const SizedBox(height: 14),
                    _OrderSummaryCard(state: state, colors: colors),
                    const SizedBox(height: 14),
                    _PaymentRow(colors: colors),
                  ],
                ),
              ),
            ),
            const AppCtaBar(),
          ],
        ),
      ),
      bottomNavigationBar: const AppBottomNav(),
    );
  }
}

class _StepProgress extends StatelessWidget {
  const _StepProgress({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final segColors = [colors.deep, colors.aqua, colors.line, colors.line];
    return Row(
      children: [
        for (var i = 0; i < segColors.length; i++) ...[
          if (i > 0) const SizedBox(width: 6),
          Expanded(child: Container(height: 4, decoration: BoxDecoration(color: segColors[i], borderRadius: BorderRadius.circular(4)))),
        ],
      ],
    );
  }
}

class _AddressCard extends StatelessWidget {
  const _AddressCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final address = context.watch<AppState>().selectedAddress;
    return AquaCard(
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: colors.sky100, borderRadius: BorderRadius.circular(AquaRadii.sm)),
            child: Icon(Icons.location_on_outlined, color: colors.deep, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  address?.titleLine ?? 'أضف عنوان التوصيل',
                  style: AquaText.arabic(size: 13.5, weight: FontWeight.w700, color: colors.ink),
                ),
                Text(
                  address?.details ?? 'لا يمكن إتمام الطلب بلا عنوان',
                  style: AquaText.arabic(size: 11.5, color: colors.ink3),
                ),
              ],
            ),
          ),
          // «تغيير» كان نصّاً لا يُضغط — والعنوان لا سبيل إلى تغييره أصلاً.
          GestureDetector(
            onTap: () => showAddressSheet(context),
            behavior: HitTestBehavior.opaque,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              child: Text(
                address == null ? 'إضافة' : 'تغيير',
                style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: colors.deep),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _DeliveryTimeCard extends StatelessWidget {
  const _DeliveryTimeCard({required this.state, required this.colors});
  final AppState state;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    Widget tile(DeliveryWhen w, String title, String sub) {
      final selected = state.when == w;
      return Expanded(
        child: GestureDetector(
          onTap: () => state.pickWhen(w),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: selected ? colors.sky050 : colors.surface,
              border: Border.all(color: selected ? colors.aqua : colors.line, width: selected ? 1.5 : 1),
              borderRadius: BorderRadius.circular(AquaRadii.md),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.ink)),
                const SizedBox(height: 3),
                Text(sub, style: AquaText.arabic(size: 11, color: colors.ink3)),
              ],
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('وقت التوصيل', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.ink)),
        const SizedBox(height: 8),
        Row(
          children: [
            tile(DeliveryWhen.now, 'الآن', 'خلال 45 دقيقة'),
            const SizedBox(width: 10),
            tile(DeliveryWhen.later, 'مجدول', 'اختر اليوم والوقت'),
          ],
        ),
      ],
    );
  }
}

class _OrderSummaryCard extends StatelessWidget {
  const _OrderSummaryCard({required this.state, required this.colors});
  final AppState state;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    Widget line(String label, String value, {Color? color}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(label, style: AquaText.arabic(size: 13, color: colors.ink2)),
              Text(value, style: AquaText.numeric(size: 13, weight: FontWeight.w600, color: color ?? colors.ink)),
            ],
          ),
        );

    return AquaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('ملخّص الطلب', style: AquaText.arabic(size: 13, weight: FontWeight.w700, color: colors.ink)),
          const SizedBox(height: 6),
          line('${state.selectedBottle?.nameAr ?? 'مياه'} × ${state.qty}', state.fmt(state.subtotal)),
          line('رسوم التوصيل', state.fmt(AppState.deliveryFee)),
          line('خصم أول طلب', state.fmt(AppState.firstOrderDiscount), color: colors.teal),
          Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: DottedDivider(color: colors.line)),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('الإجمالي', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
              Row(
                children: [
                  Text(state.fmt(state.total), style: AquaText.numeric(size: 18, weight: FontWeight.w700, color: colors.deep)),
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

class _PaymentRow extends StatelessWidget {
  const _PaymentRow({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      child: Row(
        children: [
          Icon(Icons.payments_outlined, color: colors.deep, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text('نقدًا عند التسليم', style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink))),
          Text('تغيير', style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: colors.deep)),
        ],
      ),
    );
  }
}
