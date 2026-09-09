import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';

/// شاشة "اختر مياهك" — اختيار منتج واحد من الكتالوج، وضبط الكمية
/// للمنتج المختار عبر عدّاد +/−.
class ProductSelectScreen extends StatelessWidget {
  const ProductSelectScreen({super.key});

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
                  Text('اختر مياهك', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (var i = 0; i < AppState.products.length; i++) ...[
                      if (i > 0) const SizedBox(height: 12),
                      _ProductTile(index: i, state: state, colors: colors),
                    ],
                    const SizedBox(height: 16),
                    _InfoBanner(colors: colors),
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

class _ProductTile extends StatelessWidget {
  const _ProductTile({required this.index, required this.state, required this.colors});
  final int index;
  final AppState state;
  final AquaColors colors;

  static const _icons = [Icons.water_drop_outlined, Icons.liquor_outlined, Icons.grid_view_rounded];

  @override
  Widget build(BuildContext context) {
    final product = AppState.products[index];
    final selected = state.product == index;

    return GestureDetector(
      onTap: () => state.selectProduct(index),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: selected ? colors.sky050 : colors.surface,
          border: Border.all(color: selected ? colors.aqua : colors.line, width: selected ? 1.5 : 1),
          borderRadius: BorderRadius.circular(AquaRadii.card),
        ),
        child: Column(
          children: [
            Row(
              children: [
                _RadioDot(selected: selected, colors: colors),
                const SizedBox(width: 12),
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(gradient: AquaColors.productGradient, borderRadius: BorderRadius.circular(AquaRadii.sm)),
                  child: Icon(_icons[index], color: colors.deep, size: 22),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(product.name, style: AquaText.arabic(size: 13.5, weight: FontWeight.w700, color: colors.ink)),
                      Text(product.subtitle, style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                    ],
                  ),
                ),
                Text(product.price.toStringAsFixed(3), style: AquaText.numeric(size: 14, weight: FontWeight.w700, color: colors.deep)),
              ],
            ),
            // العدّاد يتبع المنتج المختار أيًّا كان، لا الأول وحده.
            //
            // كان الشرط `selected && index == 0` نقلًا حرفيًا عن التصميم
            // الذي رسم العدّاد تحت البطاقة الأولى فقط. أثره على الجهاز:
            // من يختار العبوة أو الكرتونة يرى البطاقة تُضيء ثم لا شيء —
            // لا عدّاد ولا كمية — فيظنّ الاختيار لم يقع، بينما الإجمالي
            // في الشريط السفلي كان يتغيّر فعلًا خارج مجال نظره.
            if (selected) ...[
              const SizedBox(height: 12),
              const Divider(height: 1),
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('الكمية', style: AquaText.arabic(size: 13, weight: FontWeight.w600, color: colors.ink)),
                  const Spacer(),
                  _StepBtn(icon: Icons.remove, filled: false, onTap: state.decQty, colors: colors),
                  SizedBox(
                    width: 36,
                    child: Text('${state.qty}', textAlign: TextAlign.center, style: AquaText.numeric(size: 15, weight: FontWeight.w700, color: colors.ink)),
                  ),
                  _StepBtn(icon: Icons.add, filled: true, onTap: state.incQty, colors: colors),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _RadioDot extends StatelessWidget {
  const _RadioDot({required this.selected, required this.colors});
  final bool selected;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 20,
      height: 20,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: selected ? colors.aqua : colors.line, width: 2),
      ),
      child: selected
          ? Center(child: Container(width: 10, height: 10, decoration: BoxDecoration(color: colors.aqua, shape: BoxShape.circle)))
          : null,
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
        width: 32,
        height: 32,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          gradient: filled ? AquaColors.buttonGradient : null,
          border: filled ? null : Border.all(color: colors.line2, width: 1.5),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, size: 15, color: filled ? Colors.white : colors.ink2),
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
              'استرجاع القوارير الفارغة عند التسليم — بدون رسوم إضافية.',
              style: AquaText.arabic(size: 12, color: colors.deep, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}
