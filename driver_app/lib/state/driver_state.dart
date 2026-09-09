import 'package:flutter/foundation.dart';

/// شاشات تطبيق السائق الأربع — تقابل مفتاح `screen` في التصميم الأصلي.
enum DriverScreen { shift, detail, run, earn }

/// مرحلة واحدة من مراحل تتبّع التسليم الأربع.
class DeliveryStage {
  const DeliveryStage({required this.label, required this.time});
  final String label;
  final String time;
}

/// حالة تطبيق السائق بالكامل — تقابل `state` و`renderVals()` في
/// `Aqua Go Driver.dc.html`. كائن واحد يمسك كل شيء وينادي
/// `notifyListeners()`، بلا طبقات repository/usecase (SKILL.md).
///
/// القيم الافتراضية والحدود (clamp) منسوخة حرفيًا عن التصميم الأصلي.
/// هذه مرحلة mock محلية بلا خادم — لما يُربط بالـAPI الفعلي، هذا الملف
/// هو ما يستبدل قيمه الثابتة باستدعاءات `core/api.dart`.
class DriverState extends ChangeNotifier {
  DriverScreen screen = DriverScreen.shift;
  bool online = true;
  int step = 1; // مرحلة التسليم الحالية 0..3 — تُضبط 1 عند بدء التوصيل
  int empties = 2; // قوارير فارغة مسترجعة، محصورة 0..12

  static const String driverName = 'محمد العتوم';

  /// رقم اللوحة مُحاط بعلامتَي LRI/PDI (U+2066/U+2069) لأن مقاطعه
  /// تُقلَب داخل سياق RTL فيظهر "2718-43" بدل "43-2718". تُكتب هروبًا
  /// لا حرفيًا، وإلا حذّر المحلّل من محارف اتجاه غير مرئية في الكود.
  static const String driverPlate = 'بيك أب \u{2066}43-2718\u{2069} · عمّان';

  // إحصائيات اليوم — بيانات وهمية ثابتة كما في التصميم الأصلي.
  static const String ordersToday = '11';
  static const String earningsToday = '18.750';
  static const String rating = '4.9';

  // بيانات الطلب الحالي (mock) — طلب واحد فقط في هذا العرض التصميمي.
  static const String orderId = 'AQ-1042';
  static const String orderDistance = '2.1 كم';
  static const String orderItems = 'قارورة 18.9 لتر × 2';
  static const String orderAddress = 'خلدا · شارع وصفي التل، بناية 24';
  static const String cashToCollect = '5.250';
  static const String customerName = 'الحسن';
  static const String customerNote =
      'الرجاء الاتصال عند الوصول، الدرج على اليمين.';
  static const String etaText = '2.1 كم · 9 دقائق';

  static const List<DeliveryStage> stages = [
    DeliveryStage(label: 'تم قبول الطلب', time: '8:04 ص'),
    DeliveryStage(label: 'تحميل القوارير من المركبة', time: '8:09 ص'),
    DeliveryStage(label: 'وصلت إلى العنوان', time: 'متوقّع 8:31 ص'),
    DeliveryStage(label: 'تم التسليم والتحصيل', time: '—'),
  ];

  // الأرباح
  static const String weeklyEarnings = '96.500';
  static const List<double> weeklyBars = [
    0.38,
    0.56,
    0.44,
    0.72,
    0.60,
    0.88,
    0.30,
  ];
  static const String completedOrders = '58';
  static const String cashToRemit = '42.000';

  static const List<(String id, String place, String time, String status, String amount)>
  history = [
    ('AQ-1039', 'تلاع العلي · 8:05 ص', '', 'مسلّم', '1.250'),
    ('AQ-1036', 'الرابية · 7:42 ص', '', 'مسلّم', '1.500'),
    ('AQ-1030', 'صويلح · 7:15 ص', '', 'ملغي', '0.000'),
  ];

  void setScreen(DriverScreen s) {
    if (screen == s) return;
    screen = s;
    notifyListeners();
  }

  /// تبديل الوردية (متصل/غير متصل) — تبديل بسيط بلا تأكيد، كما في
  /// التصميم الأصلي.
  void toggleOnline() {
    online = !online;
    notifyListeners();
  }

  /// قبول العرض الظاهر في شاشة الوردية: ينتقل لتفاصيل الطلب مباشرة —
  /// لا حالة "عرض معلَّق" وسيطة في هذا العرض التصميمي.
  void acceptOffer() => setScreen(DriverScreen.detail);

  /// بدء التوصيل من شاشة تفاصيل الطلب: ينتقل لشاشة التوصيل الجاري
  /// ويصفّر عدّاد المراحل إلى 1.
  void startDelivery() {
    screen = DriverScreen.run;
    step = 1;
    notifyListeners();
  }

  void decEmpties() {
    empties = (empties - 1).clamp(0, 12);
    notifyListeners();
  }

  void incEmpties() {
    empties = (empties + 1).clamp(0, 12);
    notifyListeners();
  }

  /// زرّ الـCTA بشاشة التوصيل الجاري: يتقدّم للمرحلة التالية، وعند آخر
  /// مرحلة (3) ينهي الطلب وينتقل لشاشة الأرباح.
  void advanceOrFinish() {
    if (step < 3) {
      step = (step + 1).clamp(0, 3);
    } else {
      screen = DriverScreen.earn;
    }
    notifyListeners();
  }

  bool get isLastStep => step >= 3;
}
