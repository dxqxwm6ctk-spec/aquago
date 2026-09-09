import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';

/// شاشة "الرئيسية" — الترحيب، عنوان التوصيل، العرض الترويجي، اختيار
/// سريع للمنتجات، وبطاقة الطلب الجاري (إن وُجد).
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _AppHeader(colors: colors),
              const SizedBox(height: 18),
              _Greeting(colors: colors),
              const SizedBox(height: 16),
              _DeliveryAddressCard(colors: colors),
              const SizedBox(height: 16),
              _PromoBanner(colors: colors),
              const SizedBox(height: 20),
              _ProductsSection(colors: colors),
              const SizedBox(height: 18),
              const _ActiveOrderCard(),
            ],
          ),
        ),
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: const [AppCtaBar(), AppBottomNav()],
      ),
    );
  }
}

class _AppHeader extends StatelessWidget {
  const _AppHeader({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            gradient: AquaColors.markGradient,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(17),
              topRight: Radius.circular(17),
              bottomLeft: Radius.circular(17),
              bottomRight: Radius.circular(3),
            ),
          ),
          transform: Matrix4.rotationZ(-0.785398),
          transformAlignment: Alignment.center,
        ),
        const SizedBox(width: 8),
        RichText(
          text: TextSpan(
            style: AquaText.numeric(size: 17, weight: FontWeight.w700),
            children: [
              TextSpan(text: 'Aqua', style: TextStyle(color: colors.deep)),
              TextSpan(text: 'Go', style: TextStyle(color: colors.aqua)),
            ],
          ),
        ),
        const Spacer(),
        Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: colors.surface,
                border: Border.all(color: colors.line),
                borderRadius: BorderRadius.circular(AquaRadii.sm),
              ),
              child: Icon(Icons.notifications_none_rounded, color: colors.deep, size: 19),
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
        const SizedBox(width: 8),
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(color: colors.sky100, shape: BoxShape.circle),
          alignment: Alignment.center,
          child: Text('ا', style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: colors.deep)),
        ),
      ],
    );
  }
}

class _Greeting extends StatelessWidget {
  const _Greeting({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('مرحبًا، ${AppState.userName} 👋', style: AquaText.arabic(size: 13, color: colors.ink3)),
        const SizedBox(height: 4),
        Text('مياهك توصلك… بضغطة', style: AquaText.arabic(size: 24, weight: FontWeight.w700, color: colors.ink)),
        const SizedBox(height: 6),
        Text(
          'اطلب مياهك الآن وخلّي Aqua Go يوصّلها لباب بيتك.',
          style: AquaText.arabic(size: 13, color: colors.ink2, height: 1.5),
        ),
      ],
    );
  }
}

class _DeliveryAddressCard extends StatelessWidget {
  const _DeliveryAddressCard({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: colors.deep, borderRadius: BorderRadius.circular(AquaRadii.sm)),
            child: const Icon(Icons.location_on_outlined, color: Colors.white, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('التوصيل إلى', style: AquaText.arabic(size: 11.5, color: colors.ink3)),
                Text('عمّان · خلدا، شارع وصفي التل', style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink)),
              ],
            ),
          ),
          Icon(Icons.chevron_left_rounded, color: colors.ink3),
        ],
      ),
    );
  }
}

class _PromoBanner extends StatelessWidget {
  const _PromoBanner({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: const EdgeInsets.all(18),
      gradient: AquaColors.heroGradient,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(AquaRadii.pill)),
            child: Text('توصيل مجاني لأول طلب', style: AquaText.arabic(size: 11.5, weight: FontWeight.w600, color: Colors.white)),
          ),
          const SizedBox(height: 12),
          Text('مياه نقية توصلك خلال 45 دقيقة', style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: Colors.white)),
          const SizedBox(height: 4),
          Text('متوفّر حاليًا داخل عمّان الكبرى', style: AquaText.arabic(size: 12, color: colors.sky200)),
        ],
      ),
    );
  }
}

class _ProductsSection extends StatelessWidget {
  const _ProductsSection({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final icons = [Icons.water_drop_outlined, Icons.liquor_outlined, Icons.grid_view_rounded];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('اختر مياهك', style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: colors.ink))),
            Text('عرض الكل', style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: colors.deep)),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            for (var i = 0; i < AppState.products.length; i++) ...[
              if (i > 0) const SizedBox(width: 10),
              Expanded(
                child: AquaCard(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    children: [
                      Icon(icons[i], color: colors.deep, size: 26),
                      const SizedBox(height: 8),
                      Text(
                        i == 0 ? '18.9 لتر' : (i == 1 ? 'عبوة 4×5 لتر' : '12×1.5 لتر'),
                        textAlign: TextAlign.center,
                        style: AquaText.arabic(size: 11.5, weight: FontWeight.w600, color: colors.ink),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${AppState.products[i].price.toStringAsFixed(3)} JOD',
                        style: AquaText.numeric(size: 11, weight: FontWeight.w600, color: colors.ink3),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _ActiveOrderCard extends StatelessWidget {
  const _ActiveOrderCard();

  @override
  Widget build(BuildContext context) {
    final state = context.read<AppState>();
    final colors = context.colors;
    return GestureDetector(
      onTap: () => state.setScreen(AppScreen.track),
      child: AquaCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const LiveDot(),
                const SizedBox(width: 8),
                Text('طلبك في الطريق', style: AquaText.arabic(size: 14, weight: FontWeight.w700, color: colors.ink)),
                const Spacer(),
                Text(AppState.activeOrderId, style: AquaText.numeric(size: 12, color: colors.ink3)),
              ],
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
                      width: constraints.maxWidth * AppState.activeOrderProgress,
                      decoration: BoxDecoration(gradient: AquaColors.buttonGradient),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(AppState.activeOrderItems, style: AquaText.arabic(size: 12, color: colors.ink3)),
                Text(AppState.activeOrderEta, style: AquaText.arabic(size: 12.5, weight: FontWeight.w700, color: colors.deep)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
