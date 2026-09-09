import 'package:flutter/foundation.dart';

/// شاشات تطبيق الزبون السبع — تقابل مفتاح `screen` في التصميم الأصلي.
enum AppScreen { home, order, checkout, track, orders, wallet, account }

/// وقت التوصيل المختار في شاشة الدفع.
enum DeliveryWhen { now, later }

/// منتج واحد من كتالوج قوارير المياه — منسوخ حرفيًا عن مصفوفة `P` في
/// التصميم الأصلي.
class Product {
  const Product({
    required this.name,
    required this.subtitle,
    required this.price,
  });

  final String name;
  final String subtitle;
  final double price;
}

/// مرحلة واحدة من مراحل تتبّع الطلب الأربع.
class TrackStage {
  const TrackStage({required this.label, required this.time});
  final String label;
  final String time;
}

/// حالة تطبيق الزبون بالكامل — تقابل `state` و`renderVals()` في
/// `Aqua Go.dc.html`. كائن واحد يمسك كل شيء وينادي `notifyListeners()`،
/// بلا طبقات repository/usecase (SKILL.md).
///
/// القيم الافتراضية والحدود (clamp) والمعادلات (السعر الإجمالي) منسوخة
/// حرفيًا عن التصميم الأصلي. هذه مرحلة mock محلية بلا خادم — لما يُربط
/// بالـAPI الفعلي، هذا الملف هو ما يستبدل بياناته الثابتة باستدعاءات
/// `core/api.dart`.
class AppState extends ChangeNotifier {
  AppScreen screen = AppScreen.home;
  int product = 0;
  int qty = 2; // محصور 1..9
  DeliveryWhen when = DeliveryWhen.now;
  int step = 2; // مرحلة تتبّع الطلب الحالية 0..3

  static const String userName = 'الحسن';
  static const String userPhone = '+962 7 9041 6635';

  static const List<Product> products = [
    Product(name: 'قارورة مياه 18.9 لتر', subtitle: '5 غالون · مياه معدنية معبأة', price: 2.5),
    Product(name: 'عبوة 4×5 لتر', subtitle: 'مناسبة للمكاتب والرحلات', price: 1.75),
    Product(name: 'كرتونة 12×1.5 لتر', subtitle: 'للاستخدام اليومي في البيت', price: 2.2),
  ];

  static const double deliveryFee = 0.25;
  static const double firstOrderDiscount = -0.25;

  static const List<TrackStage> trackStages = [
    TrackStage(label: 'تم تأكيد الطلب', time: '8:02 ص'),
    TrackStage(label: 'جاري تجهيز مياهك', time: '8:09 ص'),
    TrackStage(label: 'في الطريق إليك', time: '8:21 ص'),
    TrackStage(label: 'تم التسليم', time: 'متوقّع 8:33 ص'),
  ];

  // بيانات الطلب الجاري المعروض في بطاقة الرئيسية (mock ثابت).
  static const String activeOrderId = 'AQ-1042';
  static const String activeOrderItems = 'قارورة 18.9 لتر × 2';
  static const String activeOrderEta = 'يصل خلال 12 دقيقة';
  static const double activeOrderProgress = 0.68;

  Product get selectedProduct => products[product];

  double get subtotal => selectedProduct.price * qty;
  double get total => subtotal + deliveryFee + firstOrderDiscount;

  String fmt(double n) => n.toStringAsFixed(3);

  void setScreen(AppScreen s) {
    if (screen == s) return;
    screen = s;
    notifyListeners();
  }

  void selectProduct(int index) {
    product = index;
    notifyListeners();
  }

  void decQty() {
    qty = (qty - 1).clamp(1, 9);
    notifyListeners();
  }

  void incQty() {
    qty = (qty + 1).clamp(1, 9);
    notifyListeners();
  }

  void pickWhen(DeliveryWhen w) {
    when = w;
    notifyListeners();
  }

  /// تأكيد الطلب من شاشة الدفع: ينتقل لشاشة التتبّع ويصفّر عدّاد
  /// المراحل إلى 0 ("تم تأكيد الطلب").
  void confirmOrder() {
    screen = AppScreen.track;
    step = 0;
    notifyListeners();
  }

  /// شاشة التتبّع: الضغط في أي مكان بالبطاقة يقدّم المرحلة، وتدور
  /// بعد آخر مرحلة رجوعًا للأولى (محاكاة تقدّم الطلب في هذا العرض).
  void advanceTrackStep() {
    step = (step + 1) % trackStages.length;
    notifyListeners();
  }

  /// نص الإجراء الأساسي (CTA) الحالي حسب الشاشة — يعيد null إن كانت
  /// الشاشة لا تعرض شريط CTA سفلي.
  String? get ctaLabel => switch (screen) {
        AppScreen.home => 'اطلب مياه',
        AppScreen.order => 'متابعة الطلب',
        AppScreen.checkout => 'تأكيد الطلب',
        _ => null,
      };

  void onCtaTap() {
    switch (screen) {
      case AppScreen.home:
        setScreen(AppScreen.order);
      case AppScreen.order:
        setScreen(AppScreen.checkout);
      case AppScreen.checkout:
        confirmOrder();
      default:
        break;
    }
  }
}
