// اختبارات الشاشة الرئيسية للزبون — التفاعل والربط بين الشاشات.
//
// ما تحرسه: عناصرُ الرئيسية كانت تبدو قابلة للضغط ولا تفعل شيئاً (بطاقات
// المنتجات، «عرض الكل»، بطاقة العنوان)، وبطاقةُ «طلبك في الطريق» تُعرض لكل
// زبون ببيانات ثابتة — بمن فيهم من لم يطلب قطّ. اختبارُ الدخان القائم كان
// يمرّ أخضر على ذلك كلّه لأنه يقيس التنقّل عبر الـCTA وحده.

import 'package:customer_app/core/catalog.dart';
import 'package:customer_app/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {
  group('بطاقات المنتجات في الرئيسية', () {
    testWidgets('الضغط على بطاقة يفتح شاشة الاختيار على المنتج نفسه', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // المنتج الثالث تحديداً: لو نقل `openProduct` الشاشةَ بلا ضبط
      // الفهرس، لفُتحت الشاشة على المنتج الأول (الافتراضي) ومرّ الاختبار
      // لو اكتفى بفحص الانتقال وحده.
      final third = testBottleTypes[2];
      // التمرير أولاً: محتوى الرئيسية أطول من شاشة الاختبار (600px)، فبطاقة
      // المنتج تقع تحت الشريط السفلي وتلتقط ضغطتَها عناصرُه.
      final card = find.text(third.shortName);
      await tester.ensureVisible(card);
      await tester.pumpAndSettle();
      await tester.tap(card);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.screen, AppScreen.order);
      expect(state.product, 2);
      expect(find.text(third.nameAr), findsWidgets);
    });

    testWidgets('«عرض الكل» يفتح شاشة الاختيار', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      await tester.ensureVisible(find.text('عرض الكل'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('عرض الكل'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(state.screen, AppScreen.order);
    });

    testWidgets('الأسماء تُقرأ من المنتج لا من شرطٍ على الفهرس', (
      WidgetTester tester,
    ) async {
      await pumpSignedInApp(tester);

      // كانت الرئيسية تكتب أسماءها بـ`i == 0 ? … : (i == 1 ? … : …)`،
      // فمنتجٌ رابع كان يعرض اسم الثالث، وتعديلُ اسمٍ في `products` لا يظهر
      // هنا إطلاقاً. هذا يفشل عندها لأول منتج يُعدَّل اسمه المختصر.
      for (final p in testBottleTypes) {
        expect(
          find.text(p.shortName),
          findsOneWidget,
          reason: 'اسم المنتج "${p.shortName}" غير معروض في الرئيسية',
        );
      }
    });

    testWidgets('البطاقة المختارة تُميَّز بصرياً', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      state.selectProduct(1);
      await tester.pump();

      // الرئيسية وشاشة الاختيار تعرضان الحالة نفسها — اختلافهما كان يُربك.
      expect(state.product, 1);
      expect(find.text(testBottleTypes[1].shortName), findsOneWidget);
    });
  });

  group('بطاقة الطلب الجاري', () {
    testWidgets('لا تظهر قبل أن يطلب الزبون', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      expect(state.activeOrder, isNull);
      expect(find.text('طلبك في الطريق'), findsNothing);
    });

    testWidgets('تظهر بعد تأكيد الطلب وتحمل بيانات الطلب الفعلي', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // محتوى الطلب يأتي من الخادم (`itemsLabel`) لا من نصٍّ ثابت: كان
      // «قارورة 18.9 لتر × 2» دائماً مهما اختار الزبون.
      final items = '${testBottleTypes[1].nameAr} × 3';
      state.setActiveOrderForTest(testActiveOrder(items: items));
      state.setScreen(AppScreen.home);
      await tester.pump();

      final order = state.activeOrder;
      expect(order, isNotNull);
      expect(order!.items, items);
      expect(find.text('طلبك في الطريق'), findsOneWidget);
      expect(find.text(items), findsOneWidget);
    });

    testWidgets('رقم الطلب المعروض هو رقم الخادم لا رقمٌ مولَّد محلياً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // كان التطبيق يخترع الرقم محلياً — لا وكالة تعرفه ولا سائق يصله.
      // الآن `id` هو `code` من ردّ الخادم، و`serverId` معرّفه الداخلي الذي
      // تُبنى به غرفة التتبّع.
      state.setActiveOrderForTest(testActiveOrder(id: 'AQ-7788'));
      state.setScreen(AppScreen.home);
      await tester.pump();

      expect(state.activeOrder!.id, 'AQ-7788');
      expect(state.activeOrder!.serverId, isNotNull);
      expect(find.text('AQ-7788'), findsOneWidget);
    });

    testWidgets('التقدّم يتبع مراحل التتبّع لا رقماً ثابتاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.setActiveOrderForTest(testActiveOrder());
      expect(state.activeOrder!.progress, 0);

      state.advanceTrackStep();
      final afterOne = state.activeOrder!.progress;
      expect(afterOne, greaterThan(0));

      // حتى المرحلة الأخيرة — التسليم.
      while (state.step < AppState.trackStages.length - 1) {
        state.advanceTrackStep();
      }
      expect(state.activeOrder!.progress, 1.0);
      expect(state.activeOrder!.eta, 'تم التسليم');
    });
  });

  group('عنوان التوصيل', () {
    testWidgets('مصدرٌ واحد للرئيسية وشاشة الدفع', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      // كان مكتوباً نصّاً في الشاشتين بصيغتين متباينتين، فتعديل إحداهما
      // يترك الأخرى تعرض عنواناً آخر للزبون نفسه. الآن كلتاهما تقرآن
      // العنوان المختار من الخادم.
      state.selectAddress(Address.fromJson(const {
        'id': 'addr-2',
        'label': 'المكتب',
        'street': 'شارع عبد الحميد شرف',
        'building': '7',
        'floor': '2',
        'locName': 'الشميساني',
        'lat': 31.96,
        'lng': 35.89,
        'isDefault': false,
        'covered': true,
      }));
      await tester.pump();

      expect(find.text('الشميساني · شارع عبد الحميد شرف'), findsOneWidget);

      state.setScreen(AppScreen.checkout);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('المكتب · الشميساني'), findsOneWidget);
      expect(find.text('شارع عبد الحميد شرف، بناية 7، طابق 2'), findsOneWidget);
    });

    testWidgets('الضغط على بطاقة العنوان يفتح ورقة العناوين', (
      WidgetTester tester,
    ) async {
      await pumpSignedInApp(tester);

      // السهم كان يَعِد بوجهة ولا يذهب إليها.
      await tester.ensureVisible(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();

      expect(find.text('اختر عنوان التوصيل'), findsOneWidget);
      expect(find.text('+ إضافة عنوان'), findsOneWidget);
    });
  });
}
