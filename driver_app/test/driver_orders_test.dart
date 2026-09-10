// اختبارات ربط تطبيق السائق بالخادم — العرض والطلب والسجلّ.
//
// ما تحرسه: كان كل ما في التطبيق ثوابت في الكود — `AQ-1042` و«5.250» تحصيلاً
// و«18.750» أرباحاً. بطاقةُ العرض تُعرض دائماً ما دامت الوردية مفتوحة لطلبٍ
// لا وجود له، وضغطةُ «قبول» تنقل الشاشة ولا تُخبر الخادم بشيء، والمراحل
// تتقدّم بضغطةٍ محلية بينما حالة الطلب على الخادم لم تتغيّر والزبون ينتظر.
//
// الحكم الصحيح على هذا الملف: **منطقيٌّ على العرض وفكّ الحمولة.** الحمولات
// مكتوبة بصيغة `driver-v2.controller.ts` الحقيقية، وتُحقن مباشرةً — فما
// يُقاس هو ما تعرضه الشاشة مما يصلها، وذاك لا يحتاج خادماً.

import 'package:driver_app/core/driver_models.dart';
import 'package:driver_app/state/driver_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {
  group('DriverOrder — فكّ حمولة الخادم', () {
    test('المبلغ من نصّ Decimal لا صفراً', () {
      // `as num?` على "5.250" تُعيد null فيظهر المبلغ صفراً — وهو رقمٌ
      // يقبض به السائق من الزبون.
      expect(testDriverOrder().total, 5.25);
    });

    test('المعرّفان مفصولان: المعروض والداخلي', () {
      final o = testDriverOrder();
      expect(o.code, 'AQ-1042');
      expect(o.id, 'order-uuid-1');
    });

    test('وصف المحتوى يُبنى من بنود الخادم', () {
      expect(testDriverOrder().itemsLabel, 'قارورة مياه 18.9 لتر × 2');
    });

    test('الحالات تُخطَّط على مراحل التسليم الأربع', () {
      expect(testDriverOrder(status: 'DRIVER_ASSIGNED').stageIndex, 0);
      expect(testDriverOrder(status: 'PICKED_UP').stageIndex, 1);
      expect(testDriverOrder(status: 'DELIVERING').stageIndex, 2);
      expect(testDriverOrder(status: 'COMPLETED').stageIndex, 3);
    });

    test('الحالة التالية ونصّ زرّها يتبعان تدفّق الخادم', () {
      // التدفّق يفرضه الخادم (`DRIVER_FLOW`) ويرفض ما خالفه؛ تكراره هنا
      // يمنع نداءً محكوماً بالرفض ويُبقي الزرّ صادقاً في تسميته.
      expect(testDriverOrder(status: 'DRIVER_ASSIGNED').nextStatus, 'PICKED_UP');
      expect(testDriverOrder(status: 'PICKED_UP').nextStatus, 'DELIVERING');
      expect(testDriverOrder(status: 'DELIVERING').nextStatus, 'COMPLETED');
      // لا خطوة بعد الاكتمال — ولا زرّ.
      expect(testDriverOrder(status: 'COMPLETED').nextStatus, isNull);
      expect(testDriverOrder(status: 'COMPLETED').nextActionLabel, isNull);
    });

    test('الطلب النشط يُميَّز عن المنتهي', () {
      expect(testDriverOrder(status: 'DELIVERING').isActive, isTrue);
      expect(testDriverOrder(status: 'COMPLETED').isActive, isFalse);
      expect(testDriverOrder(status: 'CANCELLED').isActive, isFalse);
    });
  });

  group('DriverStats — لا أرباح فيها', () {
    test('التقييم الغائب يُعرض «—» لا صفراً', () {
      // الصفر يبدو تقييماً سيئاً وهو غيابُ تقييمٍ أصلاً.
      final fresh = DriverStats.fromJson(const {
        'completedToday': 0,
        'completedTotal': 0,
        'ratingCount': 0,
        'status': 'AVAILABLE',
      });
      expect(fresh.rating, isNull);
      expect(fresh.ratingLabel, '—');
    });

    test('التقييم من نصّ Decimal', () {
      expect(testDriverStats.rating, 4.9);
      expect(testDriverStats.ratingLabel, '4.9');
    });
  });

  group('بطاقة العرض في شاشة الوردية', () {
    testWidgets('لا تُعرض بلا عرضٍ فعلي', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      // كانت تُعرض دائماً ما دامت الوردية مفتوحة، لطلبٍ لا وجود له.
      expect(state.offer, isNull);
      expect(find.text('طلب جديد قريب منك'), findsNothing);
      expect(find.text('قبول الطلب'), findsNothing);
    });

    testWidgets('تعرض بيانات العرض الفعلية ومؤقّته', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(pendingOffer: testDriverOffer(remainingSeconds: 45));
      await tester.pump();

      expect(find.text('طلب جديد قريب منك'), findsOneWidget);
      expect(find.text('AQ-1042'), findsOneWidget);
      expect(find.text('قارورة مياه 18.9 لتر × 2'), findsOneWidget);
      expect(find.text('خلدا'), findsOneWidget); // اسم المنطقة من الخادم
      // الثواني من الخادم لا من ساعة الجهاز.
      expect(find.text('يتبقّى 45 ثانية للردّ'), findsOneWidget);
    });

    testWidgets('المبلغ المطلوب تحصيله من الطلب لا ثابتاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(pendingOffer: testDriverOffer());
      await tester.pump();

      expect(find.textContaining('5.250'), findsOneWidget);
    });
  });

  group('سجلّ التوصيلات', () {
    testWidgets('يعرض الإحصائيات الحقيقية بلا أي مبلغ', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(driverStats: testDriverStats);
      state.setScreen(DriverScreen.earn);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('58'), findsOneWidget); // إجمالي التوصيلات
      expect(find.text('3'), findsOneWidget); // اليوم
      expect(find.text('4.9'), findsOneWidget); // التقييم

      // الأرقام المخترعة القديمة — لا يعود لها أثر.
      expect(find.text('96.500'), findsNothing);
      expect(find.text('42.000'), findsNothing);
    });

    testWidgets('سجلّ فارغ يُعلن نفسه لا يترك بياضاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(driverStats: testDriverStats, history: const []);
      state.setScreen(DriverScreen.earn);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('لا طلبات بعد — ستظهر هنا بعد أول توصيلة.'), findsOneWidget);
    });

    testWidgets('الطلبات تُعرض بحالاتها العربية', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(
        driverStats: testDriverStats,
        history: [
          testDriverOrder(status: 'COMPLETED'),
          testDriverOrder(status: 'CANCELLED'),
        ],
      );
      state.setScreen(DriverScreen.earn);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // الحالات الخام (`COMPLETED`) لا تُعرض للسائق.
      expect(find.text('مسلّم'), findsOneWidget);
      expect(find.text('ملغى'), findsOneWidget);
      expect(find.text('COMPLETED'), findsNothing);
    });
  });

  group('شاشتا الطلب بلا طلب مفتوح', () {
    testWidgets('تُعلنان الغياب لا تعرضان بياضاً', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      // الطلب قد يكون سُلّم للتوّ أو ألغاه الزبون — والسائق يحتاج أن يعرف.
      state.setScreen(DriverScreen.detail);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('لا طلب مفتوح الآن'), findsOneWidget);
      expect(find.text('العودة إلى الوردية'), findsOneWidget);
    });

    testWidgets('زرّ العودة يُرجع إلى شاشة الوردية', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setScreen(DriverScreen.run);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      await tester.tap(find.text('العودة إلى الوردية'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.screen, DriverScreen.shift);
    });
  });

  group('شاشة التوصيل مع طلب مفتوح', () {
    testWidgets('المرحلة تتبع حالة الطلب من الخادم', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(order: testDriverOrder(status: 'PICKED_UP'));
      state.setScreen(DriverScreen.run);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.currentOrder!.stageIndex, 1);
    });

    testWidgets('نصّ الزرّ يتبع الحالة لا يبقى ثابتاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setDataForTest(order: testDriverOrder(status: 'DRIVER_ASSIGNED'));
      state.setScreen(DriverScreen.detail);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('حمّلت القوارير'), findsOneWidget);

      state.setDataForTest(order: testDriverOrder(status: 'DELIVERING'));
      await tester.pump();
      expect(find.text('تم التسليم والتحصيل'), findsOneWidget);
    });
  });
}
