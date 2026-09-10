// اختبارات بثّ موقع السائق — ما تقوله شاشة الوردية عن حالة الموقع.
//
// ما تحرسه: النص تحت «وردية نشطة» كان «تستقبل الطلبات القريبة الآن» ثابتاً.
// سائقٌ رفض إذن الموقع يقرأه ويطمئن، بينما موقعه لا يصل ولا زبونَ يراه على
// الخريطة — والعطل لا يظهر لأحد حتى يشتكي زبون أن التتبّع لا يعمل.
//
// الحكم الصحيح على هذا الملف: **منطقيٌّ على العرض ودورة الحياة.**
// `geolocator` نداءُ قناةٍ إلى المنصة لا يعمل في بيئة الاختبار، فالحالات
// تُحقَن مباشرةً — وما يُقاس (نصّ الشاشة، توقّف البثّ مع الوردية) لا يحتاج
// GPS ولا خادماً. طلبُ الإذن نفسه يُختبر على جهاز.

import 'package:driver_app/core/location_broadcast.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

void main() {
  group('شاشة الوردية تقول الحقيقة عن الموقع', () {
    testWidgets('البثّ الحيّ: يُذكر أن الموقع يصل', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.live);
      await tester.pump();

      expect(find.text('تستقبل الطلبات — موقعك يصل للزبائن'), findsOneWidget);
    });

    testWidgets('إذن مرفوض: يُعلن التعطّل لا الاطمئنان', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.permissionDenied);
      await tester.pump();

      expect(find.text('إذن الموقع مرفوض — التتبّع معطّل'), findsOneWidget);
      // النص المطمئن القديم لا يظهر مع إذن مرفوض.
      expect(find.text('تستقبل الطلبات القريبة الآن'), findsNothing);
    });

    testWidgets('رفض نهائي: يُوجَّه السائق إلى إعدادات النظام', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // الفرق عن الرفض العادي ليس تفصيلاً: هذا لا يُطلب مجدداً من التطبيق
      // إطلاقاً، فنصيحةُ «اضغط للسماح» فيه تدور بالسائق بلا مخرج.
      state.location.setStatusForTest(BroadcastStatus.permissionDeniedForever);
      await tester.pump();

      expect(find.text('فعّل إذن الموقع من إعدادات النظام'), findsOneWidget);
    });

    testWidgets('خدمة الموقع مطفأة: تُميَّز عن رفض الإذن', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.locationServiceOff);
      await tester.pump();

      expect(find.text('خدمة الموقع مطفأة على جهازك'), findsOneWidget);
    });

    testWidgets('انقطاع القناة: يُعلن أن الموقع لا يصل', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.disconnected);
      await tester.pump();

      expect(find.text('انقطع الاتصال — موقعك لا يصل'), findsOneWidget);
    });

    testWidgets('الوردية مغلقة: لا حديث عن الموقع أصلاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.live);
      if (state.online) state.toggleOnline();
      await tester.pump();

      expect(find.text('اضغط لبدء استلام الطلبات'), findsOneWidget);
      expect(find.text('تستقبل الطلبات — موقعك يصل للزبائن'), findsNothing);
    });
  });

  group('دورة حياة البثّ', () {
    testWidgets('إغلاق الوردية يوقف البثّ', (WidgetTester tester) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.live);
      await tester.pump();

      // تدفّق موقعٍ حيّ يُبقي GPS يعمل ويستنزف بطارية السائق طوال ما بقي
      // التطبيق مفتوحاً — والسائق أنهى ورديته.
      if (state.online) state.toggleOnline();
      await tester.pumpAndSettle();

      expect(state.online, isFalse);
      expect(state.location.status, BroadcastStatus.off);
      expect(state.location.isLive, isFalse);
    });

    testWidgets('حالةٌ معلنة لا تبقى عالقة بعد الإغلاق', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // `start` قد يفشل قبل فتح القناة (إذن مرفوض) فيترك حالةً معلنة؛ كان
      // الإغلاق يتخطّاها فتبقى الشاشة تقول «إذن الموقع مرفوض» بعد الإنهاء.
      state.location.setStatusForTest(BroadcastStatus.permissionDenied);
      if (state.online) state.toggleOnline();
      await tester.pumpAndSettle();

      expect(state.location.status, BroadcastStatus.off);
      expect(find.text('إذن الموقع مرفوض — التتبّع معطّل'), findsNothing);
    });

    testWidgets('انتهاء الجلسة يغلق الوردية والبثّ معاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      state.location.setStatusForTest(BroadcastStatus.live);
      await tester.pump();

      // المسار المقيس هو ما يفعله التطبيق حين تنتهي الجلسة (سحبُ الجلسة من
      // الخادم، أو دخولٌ من جهاز آخر) — لا رحلةُ `logout` الشبكية: تلك
      // تنادي `/device-tokens` وتُعلّق الاختبار على نداءٍ لا يرجع هنا.
      //
      // القناة تحمل توكن الجلسة في مصافحتها — بلا إغلاقها تبقى تحاول الوصل
      // بتوكن مسحوب في حلقةِ إعادةِ وصلٍ لا تنتهي.
      state.api.onSessionEnded?.call();
      await tester.pumpAndSettle();

      expect(state.online, isFalse);
      expect(state.location.status, BroadcastStatus.off);
    });
  });
}
