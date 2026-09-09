// اختبار دخان بسيط لتطبيق السائق: يتحقق أن التطبيق يُبنى على شاشة
// الوردية، وأن التنقّل عبر الشريط السفلي بين الشاشات الأربع يعمل.

import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/main.dart';

void main() {
  testWidgets('يُبنى تطبيق السائق على شاشة الوردية افتراضيًا', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const AquaGoDriverApp());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('وردية نشطة'), findsOneWidget);
    expect(find.text('الوردية'), findsWidgets);
  });

  testWidgets('التنقّل إلى شاشة الأرباح عبر الشريط السفلي', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const AquaGoDriverApp());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('الأرباح'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('أرباح هذا الأسبوع'), findsOneWidget);
  });

  testWidgets('شاشتا تفاصيل الطلب والتوصيل تعرضان خريطة حقيقية', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const AquaGoDriverApp());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // قبول الطلب ينقل إلى تفاصيل الطلب — وفيها خريطة المسار.
    await tester.tap(find.text('قبول الطلب'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('تفاصيل الطلب'), findsOneWidget);
    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('route map view'), findsNothing);

    // "بدء التوصيل" ينقل إلى شاشة الملاحة — وفيها خريطة ثانية.
    await tester.tap(find.text('بدء التوصيل'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('التسليم الجاري'), findsOneWidget);
    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('turn-by-turn navigation'), findsNothing);
    expect(find.text('انعطف يسارًا — شارع وصفي التل'), findsOneWidget);
  });
}
