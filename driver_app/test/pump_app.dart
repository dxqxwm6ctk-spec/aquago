import 'package:driver_app/core/api_client.dart';
import 'package:driver_app/core/driver_models.dart';
import 'package:driver_app/core/theme/aqua_theme.dart';
import 'package:driver_app/screens/driver_shell.dart';
import 'package:driver_app/state/driver_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

/// يبني شجرة التطبيق **بجلسة قائمة**، متجاوزاً `AuthGate`.
///
/// اختبارات التدفّق تُعنى بشاشات الوردية والتوصيل لا بالدخول: مرورها بشاشة
/// الدخول يعني أن كل واحد منها يحتاج جوجل وFirebase وشبكةً في بيئة اختبار —
/// وهي أشياء لا تخصّ ما تقيسه. الدخول نفسه يُختبر على حدة.
/// تُعيد `DriverState` المبنية: اختبارُ سلوكٍ يبدأ من حالة بعينها (وردية
/// مغلقة، إذن موقع مرفوض) يحتاج الإمساك بها.
Future<DriverState> pumpSignedInApp(WidgetTester tester) async {
  final state = DriverState(api: ApiClient(baseUrl: 'http://localhost:0'))
    ..user = const {
      'id': 'test-driver',
      'name': 'محمد العتوم',
      'termsAccepted': true,
      'nameConfirmed': true,
      'phoneVerified': true,
    }
    ..bootstrapping = false;
  // ما يفعله `bootstrap` في التطبيق الحقيقي: بلا هذا الربط لا يصل انتهاءُ
  // الجلسة إلى الحالة، فيبدو أن سحبها لا يُغلق شيئاً وهو يُغلق.
  state.api.onSessionEnded = state.onSessionEndedForTest;

  await tester.pumpWidget(
    ChangeNotifierProvider.value(
      value: state,
      child: MaterialApp(
        locale: const Locale('ar'),
        theme: AquaTheme.light(),
        darkTheme: AquaTheme.dark(),
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child!,
        ),
        home: const DriverShell(),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return state;
}

/// طلبٌ مفتوح بصيغة ما يردّه `/driver/orders`.
DriverOrder testDriverOrder({String status = 'DRIVER_ASSIGNED'}) =>
    DriverOrder.fromJson({
      'id': 'order-uuid-1',
      'code': 'AQ-1042',
      'status': status,
      'addressText': 'خلدا · شارع وصفي التل، بناية 24',
      'total': '5.250',
      'notes': 'الرجاء الاتصال عند الوصول، الدرج على اليمين.',
      'deliveryLat': 31.9930,
      'deliveryLng': 35.8480,
      'items': const [
        {
          'qty': 2,
          'bottleType': {'nameAr': 'قارورة مياه 18.9 لتر'},
        },
      ],
      'customer': const {'name': 'الحسن', 'phone': '+962790000000'},
    });

/// عرضٌ معلّق بصيغة `/driver/offers/current`.
DriverOffer testDriverOffer({int remainingSeconds = 45}) =>
    DriverOffer.fromJson({
      'id': 'offer-1',
      'remainingSeconds': remainingSeconds,
      'zone': 'خلدا',
      'order': {
        'id': 'order-uuid-1',
        'code': 'AQ-1042',
        'status': 'AGENCY_ASSIGNED',
        'addressText': 'خلدا · شارع وصفي التل، بناية 24',
        'total': '5.250',
        'items': const [
          {
            'qty': 2,
            'bottleType': {'nameAr': 'قارورة مياه 18.9 لتر'},
          },
        ],
      },
    });

final testDriverStats = DriverStats.fromJson(const {
  'completedToday': 3,
  'completedTotal': 58,
  'rating': '4.9',
  'ratingCount': 21,
  'status': 'AVAILABLE',
});
