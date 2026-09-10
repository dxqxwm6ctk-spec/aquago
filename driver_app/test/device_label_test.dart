import 'dart:io';

import 'package:driver_app/core/device_label.dart';
import 'package:flutter_test/flutter_test.dart';

/// **تسمية الجهاز لا تكسر الطلب.**
///
/// العطل الذي يحرسه هذا الملف: الفاصل `·` (U+00B7) في التسمية جعل `dart:io`
/// يرمي `FormatException: Invalid HTTP header field value` عند تكوين الطلب،
/// فسقط النداء قبل أن يغادر الجهاز — وظهر للزبون كـ«تعذّر إتمام الدخول» وكأن
/// الخادم رفضه، والخادم لم يصله شيء أصلاً.
///
/// وأثره أوسع من الدخول: `X-Device` تُرسل مع **كل** طلب شبكة.
///
/// الحكم الصحيح على هذا الاختبار: **حقيقيٌّ على حدّ الفشل نفسه.** لا يفحص
/// النصّ بتعبير نمطي — بل يضعه في ترويسة طلبٍ فعلي إلى خادم محلي حقيقي، وهي
/// الجهة التي رمت الاستثناء أصلاً. لو تبدّل ما يقبله `dart:io` تبع الاختبارُ
/// السلوكَ الحقيقي لا افتراضنا عنه.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // **بيئة الاختبار تُبدّل طبقة HTTP بمُحاكية متساهلة** لا تتحقق من محارف
  // الترويسة، فتمرّ فيها الصيغة المكسورة التي يرفضها الجهاز فعلاً — اختبارٌ
  // عليها كان سيمرّ أخضرَ على عطلٍ قائم. `HttpOverrides.global = null` يُعيد
  // `dart:io` الحقيقي، وهو وحده الحدّ الذي انكسر على أندرويد.
  setUpAll(() => HttpOverrides.global = null);

  late HttpServer server;
  late Uri url;

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    url = Uri.parse('http://127.0.0.1:${server.port}/');
    server.listen((req) async {
      await req.drain<void>();
      req.response.statusCode = 200;
      await req.response.close();
    });
  });

  tearDownAll(() => server.close(force: true));

  /// يضع القيمة في ترويسة طلبٍ حقيقي ويُرسله — المسار نفسه الذي انكسر.
  Future<void> sendWithDeviceHeader(String value) async {
    final client = HttpClient();
    try {
      final req = await client.openUrl('GET', url);
      req.headers.set('X-Device', value); // هنا وقع FormatException
      final res = await req.close();
      await res.drain<void>();
    } finally {
      client.close(force: true);
    }
  }

  test('التسمية الفعلية تُرسل في ترويسة بلا كسر الطلب', () async {
    await expectLater(sendWithDeviceHeader(await deviceLabel()), completes);
  });

  test('الفاصل `·` — العطل الأصلي — لم يعد يمرّ في التسمية', () async {
    expect(await deviceLabel(), isNot(contains('·')));
  });

  test('التسمية ASCII مطبوع بالكامل', () async {
    final label = await deviceLabel();
    expect(label, isNotEmpty);
    for (final r in label.runes) {
      expect(
        r >= 0x20 && r <= 0x7E,
        isTrue,
        reason: 'محرف خارج ASCII المطبوع (0x${r.toRadixString(16)}) في "$label"',
      );
    }
  });

  test('التسمية لا تتجاوز ١٢٠ محرفاً — حدّ الخادم', () async {
    expect((await deviceLabel()).length, lessThanOrEqualTo(120));
  });

  /// حارس الانحدار الأوضح: لو عاد أحدٌ إلى تركيب التسمية بلا تعقيم، فهذه
  /// الصيغة بعينها — منقولةً من سجلّ الجهاز — تُسقط الطلب من جديد. وجودها
  /// هنا يُثبت أن الاختبارات أعلاه تفحص حدّاً حقيقياً لا يمرّ كل شيء.
  test('الصيغة القديمة كانت تُرفض فعلاً عند تكوين الطلب', () async {
    await expectLater(
      sendWithDeviceHeader('AquaGo Driver Android · Google sdk_gphone16k_x86_64 (SDK 37)'),
      throwsA(isA<FormatException>()),
    );
  });

  /// **`asciiSafe` تُختبر مباشرةً وبمدخلات الجهاز الحقيقية.**
  ///
  /// اختبار `deviceLabel()` وحدها لا يكفي حارساً: التسمية تتفرّع على المنصّة،
  /// وبيئة الاختبار ليست أندرويد ولا iOS — فتُرجع `'AquaGo'` ثابتةً لا تمرّ
  /// بالفرع الذي انكسر. تحقّقتُ من ذلك عملياً: بإعادة الكود المكسور بقيت تلك
  /// الاختبارات خضراء. ما يلي هو ما يمسك الانحدار فعلاً.
  group('asciiSafe — على مدخلات الجهاز', () {
    test('التسمية الكاملة كما تُبنى على أندرويد تصلح ترويسةً بعد التعقيم',
        () async {
      final sanitized =
          asciiSafe('AquaGo Driver Android · Google sdk_gphone16k_x86_64 (SDK 37)');
      await expectLater(sendWithDeviceHeader(sanitized), completes);
      expect(sanitized, isNot(contains('·')));
    });

    test('اسم جهاز بغير اللاتينية لا يكسر الترويسة', () async {
      // الخطر لا ينحصر في فاصلنا: `manufacturer`/`model` يأتيان من الجهاز
      // نفسه — جهازٌ سمّاه صاحبه بالعربية كان سيُعيد العطل بعد إصلاح `·`.
      await expectLater(
        sendWithDeviceHeader(asciiSafe('AquaGo Driver Android - هاتف سامسونج (SDK 37)')),
        completes,
      );
    });

    test('المحارف اللاتينية والأرقام والعلامات تمرّ بلا تشويه', () {
      const plain = 'AquaGo Driver Android - Google sdk_gphone16k_x86_64 (SDK 37)';
      expect(asciiSafe(plain), plain);
    });

    test('كل محرف خارج ASCII المطبوع يُستبدل ولا يُحذف', () {
      // الاستبدال لا الحذف: الطول ثابت، فالقصّ عند ١٢٠ يبقى متوقَّعاً.
      expect(asciiSafe('a·b'), 'a?b');
      expect(asciiSafe('\n\t'), '??'); // محارف تحكّم — دون 0x20
      expect(asciiSafe('emoji 🚚 here').length, 'emoji 🚚 here'.runes.length);
    });

    test('النص الفارغ يبقى فارغاً', () {
      expect(asciiSafe(''), '');
    });
  });
}
