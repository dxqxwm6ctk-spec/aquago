import 'package:customer_app/core/api_client.dart';
import 'package:customer_app/core/catalog.dart';
import 'package:customer_app/core/theme/aqua_theme.dart';
import 'package:customer_app/screens/app_shell.dart';
import 'package:customer_app/state/app_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

/// كتالوج اختبارٍ بصيغة الخادم — `sizeLiters` و`price` نصوصاً كما يرسلهما
/// Prisma لحقول `Decimal`.
final testBottleTypes = [
  BottleType.fromJson(const {
    'id': 'bt-1',
    'nameAr': 'قارورة مياه 18.9 لتر',
    'sizeLiters': '18.9',
    'price': '2.50',
  }),
  BottleType.fromJson(const {
    'id': 'bt-2',
    'nameAr': 'عبوة 4×5 لتر',
    'sizeLiters': '5',
    'price': '1.75',
  }),
  BottleType.fromJson(const {
    'id': 'bt-3',
    'nameAr': 'كرتونة 12×1.5 لتر',
    'sizeLiters': '1.5',
    'price': '2.20',
  }),
];

final testAddresses = [
  Address.fromJson(const {
    'id': 'addr-1',
    'label': 'البيت',
    'street': 'شارع وصفي التل',
    'building': '24',
    'floor': '3',
    'locName': 'خلدا',
    'lat': 31.9930,
    'lng': 35.8480,
    'isDefault': true,
    'covered': true,
  }),
];

/// يبني شجرة التطبيق **بجلسة قائمة**، متجاوزاً `AuthGate`.
///
/// اختبارات التدفّق تُعنى بشاشات الطلب لا بالدخول: مرورها بشاشة الدخول يعني
/// أن كل واحد منها يحتاج جوجل وFirebase وشبكةً في بيئة اختبار — وهي أشياء لا
/// تخصّ ما تقيسه. الدخول نفسه يُختبر على حدة.
///
/// تُعيد `AppState` المبنية: اختبارُ سلوكٍ يبدأ من حالة بعينها (منتج مختار،
/// طلب قائم، عنوان آخر) يحتاج الإمساك بها، ويحتاج قراءتها بعد الضغط ليتحقّق
/// من أن التنقّل غيّر الحالة فعلاً لا أن الشاشة تبدّلت بالصدفة.
Future<AppState> pumpSignedInApp(WidgetTester tester) async {
  final state = AppState(api: ApiClient(baseUrl: 'http://localhost:0'))
    ..user = const {
      'id': 'test-user',
      'name': 'الحسن',
      'phone': '+962 7 9041 6635',
      'termsAccepted': true,
      'nameConfirmed': true,
      'phoneVerified': true,
    }
    ..bootstrapping = false
    // كتالوج وعنوان محقونان: `loadCatalog` رحلةُ شبكةٍ لا ترجع في بيئة
    // الاختبار، وبدونهما تُبنى كل شاشة على قائمة فارغة فلا يبقى ما يُقاس.
    // القيم تحاكي ما يردّه الخادم فعلاً.
    ..bottleTypes = testBottleTypes
    ..addresses = testAddresses
    ..selectedAddress = testAddresses.first;

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
        home: const AppShell(),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  return state;
}

/// طلبٌ جارٍ جاهز للاختبار — بصيغة ما يبنيه `confirmOrder` من ردّ الخادم.
ActiveOrder testActiveOrder({String id = 'AQ-1042', String? items}) =>
    ActiveOrder(
      id: id,
      serverId: 'order-uuid-1',
      items: items ?? '${testBottleTypes.first.nameAr} × 2',
      eta: 'يصل خلال 12 دقيقة',
      progress: 0,
    );
