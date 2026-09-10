// اختبار دخان بسيط لتطبيق الزبون: يتحقق أن التطبيق يُبنى على الشاشة
// الرئيسية، وأن التنقّل عبر الشريط السفلي والـCTA يعمل.
//
// يبدأ من `pumpSignedInApp` لا من `AquaGoApp`: الأخير يبدأ الآن بـ`AuthGate`
// وشاشة الدخول، وهي ليست ما تقيسه هذه الاختبارات.


import 'package:customer_app/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:customer_app/core/ui/aqua_map.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {

  testWidgets('يُبنى تطبيق الزبون على الشاشة الرئيسية افتراضيًا', (
    WidgetTester tester,
  ) async {
    await pumpSignedInApp(tester);

    expect(find.text('مياهك توصلك… بضغطة'), findsOneWidget);
    expect(find.text('اطلب مياه'), findsOneWidget);
  });

  testWidgets('التنقّل من الرئيسية إلى اختيار المياه ثم تأكيد الطلب', (
    WidgetTester tester,
  ) async {
    await pumpSignedInApp(tester);

    await tester.tap(find.text('اطلب مياه'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('اختر مياهك'), findsWidgets);

    await tester.tap(find.text('متابعة الطلب'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('تأكيد الطلب'), findsWidgets);
  });

  testWidgets('عدّاد الكمية يظهر لأي منتج يُختار لا للأول وحده', (
    WidgetTester tester,
  ) async {
    await pumpSignedInApp(tester);

    await tester.tap(find.text('اطلب مياه'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // المنتج الأول مختار افتراضيًا: العدّاد والإجمالي 2.500×2
    expect(find.text('الكمية'), findsOneWidget);
    expect(find.text('5.000'), findsOneWidget);

    // اختيار الثاني: العدّاد يبقى ظاهرًا (كان يختفي فيبدو الاختيار بلا أثر)
    await tester.tap(find.text('عبوة 4×5 لتر'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('الكمية'), findsOneWidget);
    expect(find.text('3.500'), findsOneWidget); // 1.750 × 2

    // والثالث كذلك
    await tester.tap(find.text('كرتونة 12×1.5 لتر'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('الكمية'), findsOneWidget);
    expect(find.text('4.400'), findsOneWidget); // 2.200 × 2
  });

  testWidgets('شاشة التتبّع تعرض خريطة حقيقية لا عنصرًا نائبًا', (
    WidgetTester tester,
  ) async {
    final state = await pumpSignedInApp(tester);

    // البطاقة لا تُعرض بلا طلب — وهذا مقصود: كانت تظهر لكل زبون ببيانات
    // ثابتة، بمن فيهم من لم يطلب قطّ. فيُنشأ طلبٌ أولاً ثم يُتتبَّع.
    state.setActiveOrderForTest(testActiveOrder());
    state.setScreen(AppScreen.home);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // بطاقة "طلبك في الطريق" أسفل الشاشة الرئيسية — خارج نافذة
    // الاختبار (800×600) فتحتاج تمريرًا إليها قبل النقر.
    final card = find.text('طلبك في الطريق');
    await tester.dragUntilVisible(card, find.byType(SingleChildScrollView).first, const Offset(0, -120));
    await tester.pump();

    await tester.tap(card);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('تتبّع الطلب'), findsOneWidget);
    // وجود `FlutterMap` هو ما يميّز الخريطة الفعلية عن النائب السابق
    // الذي كان مجرّد مستطيل ملوّن يحمل النص "live map view".
    expect(find.byType(FlutterMap), findsOneWidget);
    expect(find.text('live map view'), findsNothing);
    // المسافة لم تعد نصّاً ثابتاً («على بعد 2.1 كم» مهما تحرّك السائق):
    // تصل من الخادم مع `driver:location`. وبلا اتصال في بيئة الاختبار
    // تُعلَن الحالة بدل عرض رقمٍ مخترَع.
    expect(find.text('على بعد 2.1 كم'), findsNothing);
    expect(find.byType(MapBadge), findsOneWidget);
  });
}
