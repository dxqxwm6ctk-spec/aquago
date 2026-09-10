import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';
import 'address_sheet.dart';

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
        Text('مرحبًا، ${context.watch<AppState>().userName} 👋', style: AquaText.arabic(size: 13, color: colors.ink3)),
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
    final state = context.watch<AppState>();
    final address = state.selectedAddress;
    return GestureDetector(
      // ورقة العناوين لا شاشة الدفع: الضغط هنا يعني «أريد تغيير العنوان»،
      // وإرسالُ الزبون إلى شاشة الطلب ليجد الأمر هناك التفافٌ لا وجهة.
      onTap: () => showAddressSheet(context),
      behavior: HitTestBehavior.opaque,
      child: AquaCard(
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
                Text(
                  // لا عنوان بعد ⇐ دعوةٌ لإضافته: الزبون الجديد كان يرى
                  // عنواناً محفوظاً ليس له، ثم يُرفض طلبه بلا سبب ظاهر.
                  address?.oneLine ?? 'أضف عنوان التوصيل',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: colors.ink),
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_left_rounded, color: colors.ink3),
        ],
      ),
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
    // `watch` لا `read`: الكتالوج يصل من الخادم بعد أول رسم، فقراءةٌ لا
    // تستمع كانت تُبقي القسم فارغاً حتى تُعاد الشاشة لسبب آخر.
    final state = context.watch<AppState>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text('اختر مياهك', style: AquaText.arabic(size: 15, weight: FontWeight.w700, color: colors.ink))),
            // «عرض الكل» كان نصاً لا يُضغط — يَعِد بوجهة ولا يذهب إليها.
            GestureDetector(
              onTap: () => state.setScreen(AppScreen.order),
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                child: Text('عرض الكل', style: AquaText.arabic(size: 12.5, weight: FontWeight.w600, color: colors.deep)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        // ثلاث حالات قبل البطاقات: يُحمَّل، فشل، أو لا منتجات. كلٌّ منها كان
        // يظهر فراغاً أبيض تحت العنوان — يبدو عطباً في التطبيق لا انتظاراً.
        if (state.loadingCatalog && state.bottleTypes.isEmpty)
          _SectionNote(text: 'جارٍ تحميل المنتجات…', colors: colors)
        else if (state.catalogError != null && state.bottleTypes.isEmpty)
          _SectionNote(text: state.catalogError!, colors: colors, danger: true)
        else if (state.bottleTypes.isEmpty)
          _SectionNote(text: 'لا منتجات متاحة حالياً', colors: colors)
        else
        // `IntrinsicHeight` يُسوّي ارتفاع البطاقات: اسمٌ يلتفّ سطرين كان
        // يُطيل بطاقته وحدها فتبدو الصفّة غير مستوية.
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < state.bottleTypes.length; i++) ...[
                if (i > 0) const SizedBox(width: 10),
                Expanded(child: _ProductCard(index: i, colors: colors)),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// سطر حالة مكان البطاقات: تحميل، خطأ، أو لا منتجات.
class _SectionNote extends StatelessWidget {
  const _SectionNote({
    required this.text,
    required this.colors,
    this.danger = false,
  });

  final String text;
  final AquaColors colors;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: AquaText.arabic(
          size: 12.5,
          color: danger ? colors.dangerFg : colors.ink3,
        ),
      ),
    );
  }
}

/// بطاقة منتج واحدة في الرئيسية — تُختار وتفتح شاشة الاختيار بضغطة.
class _ProductCard extends StatelessWidget {
  const _ProductCard({required this.index, required this.colors});

  final int index;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final product = state.bottleTypes[index];
    // المنتج المختار يُميَّز هنا كما في شاشة الاختيار: الشاشتان تعرضان
    // الحالة نفسها، فاختلافهما كان يُربك لا يُفيد.
    final selected = state.product == index;

    return GestureDetector(
      onTap: () => context.read<AppState>().openProduct(index),
      behavior: HitTestBehavior.opaque,
      child: AquaCard(
        padding: const EdgeInsets.all(12),
        border: selected ? Border.all(color: colors.aqua, width: 1.5) : null,
        color: selected ? colors.sky050 : null,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(product.icon, color: colors.deep, size: 26),
            const SizedBox(height: 8),
            Text(
              product.shortName,
              textAlign: TextAlign.center,
              style: AquaText.arabic(size: 11.5, weight: FontWeight.w600, color: colors.ink),
            ),
            const SizedBox(height: 4),
            Text(
              '${product.price.toStringAsFixed(3)} JOD',
              style: AquaText.numeric(size: 11, weight: FontWeight.w600, color: colors.ink3),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActiveOrderCard extends StatelessWidget {
  const _ActiveOrderCard();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final order = state.activeOrder;
    // لا طلب ⇐ لا بطاقة. كانت تُعرض دائماً ببيانات ثابتة، فيرى الزبون
    // الجديد «طلبك في الطريق» قبل أن يطلب شيئاً.
    if (order == null) return const SizedBox.shrink();

    final colors = context.colors;
    return GestureDetector(
      onTap: () => context.read<AppState>().setScreen(AppScreen.track),
      behavior: HitTestBehavior.opaque,
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
                Text(order.id, style: AquaText.numeric(size: 12, color: colors.ink3)),
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
                      width: constraints.maxWidth * order.progress,
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
                Text(order.items, style: AquaText.arabic(size: 12, color: colors.ink3)),
                Text(order.eta, style: AquaText.arabic(size: 12.5, weight: FontWeight.w700, color: colors.deep)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
