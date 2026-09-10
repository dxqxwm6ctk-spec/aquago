// اختبارات ورقة العناوين وتحديث حالة الطلب الحيّ.
//
// ما تحرسه:
//  • لم يكن في التطبيق ما يُنشئ عنواناً — العناوين تُقرأ ولا تُكتب، بينما
//    `POST /orders` يشترط `addressId`. فزبونٌ جديد لا يستطيع أن يطلب أصلاً.
//  • شاشة المتابعة كانت تتجمّد على المرحلة الأولى: الطلب يعود `CREATED`
//    والتوزيع يجري في طابور، فلا شيء يُحرّك المؤشّر حتى تُعاد الشاشة.

import 'package:customer_app/core/catalog.dart';
import 'package:customer_app/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {
  group('ورقة العناوين', () {
    testWidgets('تعرض العناوين المحفوظة وتميّز المختار', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      await tester.ensureVisible(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();

      expect(find.text('اختر عنوان التوصيل'), findsOneWidget);
      expect(find.text(testAddresses.first.titleLine), findsOneWidget);
      expect(state.selectedAddress?.id, testAddresses.first.id);
    });

    testWidgets('«إضافة عنوان» تفتح النموذج بحقوله الإلزامية', (
      WidgetTester tester,
    ) async {
      await pumpSignedInApp(tester);

      await tester.ensureVisible(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('+ إضافة عنوان'));
      await tester.pumpAndSettle();

      // البناية والطابق إلزاميان على الخادم (`CreateAddressDto`) — نموذجٌ
      // بلا حقلٍ لهما يُنتج 400 برسالة تحقّق إنجليزية لا تعني الزبون شيئاً.
      expect(find.text('عنوان جديد'), findsOneWidget);
      expect(find.text('الشارع'), findsOneWidget);
      expect(find.text('رقم البناية'), findsOneWidget);
      expect(find.text('الطابق'), findsOneWidget);
      expect(find.text('حفظ العنوان'), findsOneWidget);
    });

    testWidgets('الحقول الناقصة تُمنع محلياً قبل رحلة الشبكة', (
      WidgetTester tester,
    ) async {
      await pumpSignedInApp(tester);

      await tester.ensureVisible(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('+ إضافة عنوان'));
      await tester.pumpAndSettle();

      // الحقول فارغة عدا الاسم — الحفظ يجب أن يُردّ هنا لا أن يسافر ويعود
      // برسالة الخادم الإنجليزية.
      await tester.tap(find.text('حفظ العنوان'));
      await tester.pumpAndSettle();

      expect(find.text('الاسم والشارع والبناية والطابق مطلوبة'), findsOneWidget);
      // الورقة تبقى مفتوحة: إغلاقها كان سيوهم الزبون أن العنوان حُفظ.
      expect(find.text('عنوان جديد'), findsOneWidget);
    });

    testWidgets('العنوان خارج التغطية يُعرض ولا يُختار', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // الخادم يرفض الطلب على عنوانٍ خارج التغطية؛ اختيارُه يقود الزبون إلى
      // رفضٍ لم يفعل شيئاً ليستحقّه.
      final outside = Address.fromJson(const {
        'id': 'addr-out',
        'label': 'المزرعة',
        'street': 'طريق المطار',
        'locName': 'ناعور',
        'lat': 31.86,
        'lng': 35.82,
        'isDefault': false,
        'covered': false,
      });
      state.setAddressesForTest(
        [...state.addresses, outside],
        selected: state.selectedAddress,
      );

      await tester.ensureVisible(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('التوصيل إلى'));
      await tester.pumpAndSettle();

      expect(find.text('خارج نطاق التغطية حالياً'), findsOneWidget);

      await tester.tap(find.text(outside.titleLine));
      await tester.pumpAndSettle();

      // لم يُختَر ولم تُغلق الورقة.
      expect(state.selectedAddress?.id, isNot('addr-out'));
    });

    testWidgets('بلا عناوين: الرئيسية تدعو لإضافة واحد', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // الزبون الجديد كان يرى عنواناً محفوظاً ليس له، ثم يُرفض طلبه.
      state.setAddressesForTest(const []);
      await tester.pump();

      expect(find.text('أضف عنوان التوصيل'), findsOneWidget);
    });
  });

  group('حدث order:status', () {
    testWidgets('الملاحظة من الخادم تُعرض في شاشة التتبّع', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);
      state.setActiveOrderForTest(testActiveOrder());
      await tester.pump();

      // الزبون ينتظر بلا كلمة بدونها: «جارٍ البحث عن سائق» تفسّر التأخّر.
      state.tracking.applyStatusEvent(const {
        'orderId': 'order-uuid-1',
        'status': 'AGENCY_ASSIGNED',
        'noteAr': 'جارٍ البحث عن سائق قريب',
      });
      await tester.pump();

      expect(find.text('جارٍ البحث عن سائق قريب'), findsOneWidget);
    });

    testWidgets('مرحلة المؤشّر تتبع حالة الطلب من الخادم', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);
      state.setActiveOrderForTest(testActiveOrder());
      await tester.pump();

      Order at(String status) => Order.fromJson({
            'id': 'order-uuid-1',
            'code': 'AQ-1042',
            'status': status,
            'items': const [],
          });

      // كانت المرحلة تتقدّم بضغطةٍ يدوية على البطاقة (محاكاة قديمة)، ولا
      // شيء يربطها بما يجري فعلاً.
      state.tracking.setOrderForTest(at('CREATED'));
      await tester.pump();
      expect(state.tracking.order!.stageIndex, 0);

      state.tracking.setOrderForTest(at('DRIVER_ASSIGNED'));
      await tester.pump();
      expect(state.tracking.order!.stageIndex, 1);

      state.tracking.setOrderForTest(at('DELIVERING'));
      await tester.pump();
      expect(state.tracking.order!.stageIndex, 2);
    });

    testWidgets('بطاقة السائق لا تُعرض قبل تعيينه', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);
      state.setActiveOrderForTest(testActiveOrder());
      await tester.pump();

      // كانت تعرض «محمد العتوم» ورقم لوحةٍ ثابتَين منذ لحظة الطلب.
      state.tracking.setOrderForTest(Order.fromJson(const {
        'id': 'order-uuid-1',
        'code': 'AQ-1042',
        'status': 'CREATED',
        'items': [],
      }));
      await tester.pump();
      expect(find.text('محمد العتوم'), findsNothing);

      state.tracking.setOrderForTest(Order.fromJson(const {
        'id': 'order-uuid-1',
        'code': 'AQ-1042',
        'status': 'DRIVER_ASSIGNED',
        'items': [],
        'driver': {'name': 'أحمد الزعبي', 'phone': '+962790000000'},
      }));
      await tester.pumpAndSettle();

      expect(find.text('أحمد الزعبي'), findsOneWidget);
    });

    testWidgets('إيقاف التتبّع يمسح الطلب والملاحظة', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);
      state.setActiveOrderForTest(testActiveOrder());
      state.tracking.applyStatusEvent(const {
        'orderId': 'order-uuid-1',
        'status': 'AGENCY_ASSIGNED',
        'noteAr': 'جارٍ البحث عن سائق قريب',
      });
      await tester.pump();

      // ملاحظةٌ باقية بعد المغادرة تظهر على طلبٍ آخر لاحقاً.
      //
      // `pump` لا `pumpAndSettle`: القناة تعيد محاولة الوصل بمؤقّت دوري في
      // بيئة الاختبار، فانتظارُ سكونٍ تامّ انتظارٌ لما لا يقع.
      state.setScreen(AppScreen.home);
      await tester.pump();

      expect(state.tracking.order, isNull);
      expect(state.tracking.statusNote, isNull);
    });
  });
}
