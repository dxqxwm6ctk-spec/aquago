// اختبار دخان بسيط لتطبيق السائق: يتحقق أن التطبيق يُبنى على شاشة
// الوردية، وأن التنقّل عبر الشريط السفلي بين الشاشات الأربع يعمل.

import 'package:driver_app/state/driver_state.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {
  testWidgets('يُبنى تطبيق السائق على شاشة الوردية افتراضيًا', (
    WidgetTester tester,
  ) async {
    await pumpSignedInApp(tester);

    expect(find.text('وردية نشطة'), findsOneWidget);
    expect(find.text('الوردية'), findsWidgets);
  });

  testWidgets('التنقّل إلى سجلّ التوصيلات عبر الشريط السفلي', (
    WidgetTester tester,
  ) async {
    final state = await pumpSignedInApp(tester);
    state.setDataForTest(driverStats: testDriverStats);
    await tester.pump();

    // كانت «الأرباح» بأرقامٍ مخترعة لا مصدر لها على الخادم — أجرُ السائق
    // تحاسبه وكالته لا المنصة.
    await tester.tap(find.text('سجلّي'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('سجلّ التوصيلات'), findsOneWidget);
    expect(find.text('توصيلاتك حتى الآن'), findsOneWidget);
    expect(find.text('58'), findsOneWidget);
    expect(find.text('أرباح هذا الأسبوع'), findsNothing);
  });

  testWidgets('شاشتا تفاصيل الطلب والتوصيل تعرضان خريطة حقيقية', (
    WidgetTester tester,
  ) async {
    final state = await pumpSignedInApp(tester);

    // الطلب يُحقن لا يُقبل بضغطة: القبول صار نداءً إلى الخادم
    // (`/driver/offers/:id/accept`)، وما يقيسه هذا الاختبار هو الخريطة.
    state.setDataForTest(order: testDriverOrder());
    state.setScreen(DriverScreen.detail);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('تفاصيل الطلب'), findsOneWidget);
    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('route map view'), findsNothing);

    // شاشة الملاحة — وفيها خريطة ثانية.
    state.setScreen(DriverScreen.run);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('التسليم الجاري'), findsOneWidget);
    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('turn-by-turn navigation'), findsNothing);
    expect(find.text('انعطف يسارًا — شارع وصفي التل'), findsOneWidget);
  });
}
