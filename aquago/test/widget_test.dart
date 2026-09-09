// اختبار دخان بسيط: يتحقق أن الهيكل الفارغ يُبنى.
// الشاشات الفعلية انتقلت إلى ../customer_app و../driver_app و web_admin/.

import 'package:flutter_test/flutter_test.dart';

import 'package:aquago/main.dart';

void main() {
  testWidgets('يُبنى التطبيق', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    expect(find.text('AquaGo'), findsOneWidget);
  });
}
