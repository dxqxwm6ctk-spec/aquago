// اختبارات التتبّع الحيّ — عرض موقع السائق وحالة القناة.
//
// ما تحرسه: الخريطة كانت تعرض نقطتين ثابتتين وشارةً مكتوبة نصّاً «على بعد
// 2.1 كم» لا تتغيّر مهما تحرّك السائق — بينما الخادم يبثّ `driver:location`
// منذ البداية ولا أحد يسمعه.
//
// الحكم الصحيح على هذا الملف: **منطقيٌّ على العرض، لا على الشبكة.** يحقن
// المواقع في `TrackingService` مباشرةً بدل وصل Socket حقيقي — فما يُقاس هنا
// هو أن الشاشة تعرض ما يصلها وتُعلن حالتها، وذاك يُتحقَّق منه كاملاً بلا
// خادم. مصافحة Socket نفسها تُختبر على جهاز مقابل خادم حيّ.

import 'package:customer_app/core/tracking_service.dart';
import 'package:customer_app/core/ui/aqua_map.dart';
import 'package:customer_app/state/app_state.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pump_app.dart';

/// يحقن حمولة `driver:location` بصيغتها الحقيقية من الخادم.
///
/// الحمولة كما يبنيها `tracking-v2.gateway.ts`: `{lat, lng, eta}` حيث `eta`
/// ناتج `estimateEta` — `{minutes, distanceKm, viaWarehouse}`. حقنُ الحمولة
/// لا الكائن المفكوك يجعل الاختبار يحرس قراءةَ الحقول أيضاً: تبديلُ اسم حقل
/// على الخادم يفشل هنا بدل أن يمرّ صامتاً إلى خريطةٍ لا تتحرّك.
void injectLocation(
  TrackingService tracking, {
  required double lat,
  required double lng,
  int? etaMinutes,
  double? distanceKm,
  bool viaWarehouse = false,
}) {
  tracking.applyLocationEvent({
    'driverId': 'driver-1',
    'lat': lat,
    'lng': lng,
    if (etaMinutes != null || distanceKm != null)
      'eta': {
        'minutes': etaMinutes,
        'distanceKm': distanceKm,
        'viaWarehouse': viaWarehouse,
      },
  });
}

Future<AppState> pumpTracking(WidgetTester tester) async {
  final state = await pumpSignedInApp(tester);
  // حقنٌ لا `confirmOrder`: الأخير صار يرحل إلى الخادم، وما يُقاس هنا هو
  // عرضُ التتبّع بعد قيام الطلب لا رحلةُ إنشائه.
  state.setActiveOrderForTest(testActiveOrder());
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return state;
}

void main() {
  group('شارة التتبّع تقول الحقيقة عن الحالة', () {
    testWidgets('بلا موقع بعد: تُعلن الانتظار لا رقماً مخترعاً', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      state.tracking.setStatusForTest(TrackingStatus.waitingForDriver);
      await tester.pump();

      expect(find.text('بانتظار موقع السائق'), findsOneWidget);
      // النص الثابت القديم — لا يعود يظهر بأي حال.
      expect(find.text('على بعد 2.1 كم'), findsNothing);
    });

    testWidgets('مع موقع حيّ: المسافة والوقت من الخادم', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      injectLocation(
        state.tracking,
        lat: 32.0270,
        lng: 35.8330,
        etaMinutes: 7,
        distanceKm: 3.4,
      );
      await tester.pump();

      expect(find.text('على بعد 3.4 كم · 7 دقيقة'), findsOneWidget);
    });

    testWidgets('المرور بالمستودع يُذكر — يفسّر طول الوقت رغم القرب', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      injectLocation(
        state.tracking,
        lat: 32.0270,
        lng: 35.8330,
        etaMinutes: 15,
        distanceKm: 2.0,
        viaWarehouse: true,
      );
      await tester.pump();

      expect(find.text('على بعد 2.0 كم · 15 دقيقة (عبر المستودع)'), findsOneWidget);
    });

    testWidgets('الموقع المتقادم يُعلن قِدَمه لا يُعرض كأنه حيّ', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      // بثّ السائق دوري؛ صمتٌ يتجاوز دقيقة يعني انقطاعاً لم تعلنه القناة.
      // بلا هذا تبقى الخريطة تعرض آخر موقع إلى الأبد وتبدو صحيحة.
      injectLocation(
        state.tracking,
        lat: 32.0270,
        lng: 35.8330,
        etaMinutes: 7,
        distanceKm: 3.4,
      );
      // يُقدَّم زمن الاستلام خمس دقائق — كما لو انقطع البثّ بعد آخر موقع.
      state.tracking.setStatusForTest(
        TrackingStatus.live,
        at: DateTime.now().subtract(const Duration(minutes: 5)),
      );
      await tester.pump();

      expect(state.tracking.isStale, isTrue);
      expect(find.text('آخر موقع معروف'), findsOneWidget);
      expect(find.text('على بعد 3.4 كم · 7 دقيقة'), findsNothing);
    });

    testWidgets('الانقطاع بلا موقع سابق: يُعرض سبب العطل', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      state.tracking.setStatusForTest(
        TrackingStatus.disconnected,
        message: 'تعذّر الاتصال بالتتبّع',
      );
      await tester.pump();

      expect(find.text('تعذّر الاتصال بالتتبّع'), findsOneWidget);
    });
  });

  group('الخريطة تتبع الموقع', () {
    testWidgets('علامة السائق لا تُرسم قبل وصول موقعه', (
      WidgetTester tester,
    ) async {
      await pumpTracking(tester);

      // علامةٌ في موضعٍ مفترض أسوأ من غيابها: الزبون يصدّقها ويقيس عليها.
      // الوجهة وحدها تُرسم — علامة واحدة.
      final map = tester.widget<AquaMap>(find.byType(AquaMap));
      expect(map.markers.length, 1);
      expect(map.route, isEmpty);
    });

    testWidgets('وصول الموقع يرسم علامة السائق وخطّ المسار', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      injectLocation(state.tracking, lat: 32.0270, lng: 35.8330);
      await tester.pump();

      final map = tester.widget<AquaMap>(find.byType(AquaMap));
      expect(map.markers.length, 2);
      expect(map.route.length, 2);
      expect(map.route.first.latitude, closeTo(32.0270, 0.0001));
    });

    testWidgets('تحرّك السائق ينقل علامته — لا تبقى على أول موقع', (
      WidgetTester tester,
    ) async {
      final state = await pumpTracking(tester);

      injectLocation(state.tracking, lat: 32.0270, lng: 35.8330);
      await tester.pump();
      final before = tester.widget<AquaMap>(find.byType(AquaMap)).route.first;

      injectLocation(state.tracking, lat: 32.0150, lng: 35.8400);
      await tester.pump();
      final after = tester.widget<AquaMap>(find.byType(AquaMap)).route.first;

      expect(after.latitude, isNot(before.latitude));
      expect(after.latitude, closeTo(32.0150, 0.0001));
    });

    testWidgets('الخريطة تتبع النقاط — followPoints مفعّل', (
      WidgetTester tester,
    ) async {
      await pumpTracking(tester);

      // `initialCameraFit` يُحسب مرة واحدة كما يقول اسمه: بلا هذا كانت
      // علامة السائق تخرج من الإطار بعد دقائق فيرى الزبون خريطة بلا سائق.
      expect(tester.widget<AquaMap>(find.byType(AquaMap)).followPoints, isTrue);
      expect(find.byType(FlutterMap), findsOneWidget);
    });
  });

  group('دورة حياة القناة', () {
    testWidgets('تُغلق عند مغادرة شاشة التتبّع', (WidgetTester tester) async {
      final state = await pumpTracking(tester);

      // قناةٌ مفتوحة بلا شاشة تستهلك بطارية وبيانات بلا مستفيد.
      state.setScreen(AppScreen.home);
      await tester.pump();

      expect(state.tracking.isTracking, isFalse);
      expect(state.tracking.status, TrackingStatus.idle);
    });

    testWidgets('لا تُفتح لشاشة التتبّع بلا طلب قائم', (
      WidgetTester tester,
    ) async {
      final state = await pumpSignedInApp(tester);

      // بلا طلب كانت ستشترك في غرفة طلبٍ لا وجود له فيردّ الخادم بالرفض.
      state.setScreen(AppScreen.track);
      await tester.pump();

      expect(state.activeOrder, isNull);
      expect(state.tracking.isTracking, isFalse);
    });
  });
}
