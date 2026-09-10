import 'dart:convert';

import 'package:driver_app/core/api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// اختبارات طبقة الجلسة — أثقل ما في العميل هو تمييز «انتهت الجلسة» عن «عطل
/// مؤقت»: الخلط بينهما يطرد الزبون كلما تعثّرت الشبكة.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  ApiClient client() => ApiClient(baseUrl: 'http://localhost:0');

  test('التوكنان يُحفظان ويُقرآن من القرص', () async {
    await client().saveTokens('access-1', 'refresh-1');

    final revived = client();
    await revived.loadTokens();

    expect(revived.isLoggedIn, isTrue);
    expect(revived.token, 'access-1');
  });

  test('نداء يحتاج هوية بلا جلسة يُردّ محلياً بلا رحلة شبكة', () async {
    final api = client();
    await expectLater(
      api.get('/notifications/unread-count'),
      throwsA(
        isA<ApiException>()
            .having((e) => e.statusCode, 'statusCode', 401)
            .having((e) => e.message, 'message', 'سجّل دخولك أولاً'),
      ),
    );
  });

  test('مسارات الدخول لا تحتاج هوية', () {
    // القائمة مطابقة لما لا يحمل `JwtV2Guard` على الخادم.
    expect(ApiClient.debugNeedsAuth('/auth/google-login'), isFalse);
    expect(ApiClient.debugNeedsAuth('/auth/refresh'), isFalse);
    expect(ApiClient.debugNeedsAuth('/app-version/check'), isFalse);
    expect(ApiClient.debugNeedsAuth('/orders'), isTrue);
  });

  group('التجديد', () {
    test('رفض الخادم لتوكن التجديد يُنهي الجلسة ويحمل سببها', () async {
      final api = client();
      await api.saveTokens('dead-access', 'dead-refresh');

      var ended = false;
      api.onSessionEnded = () => ended = true;

      await api.debugHandleRefreshResponse(
        // `Response` النصّية تُرمّز بـlatin1 فتختنق بالعربية — نمرّر البايتات.
        http.Response.bytes(
          utf8.encode(
            jsonEncode({
              'message':
                  'سُجّل الدخول إلى حسابك من جهاز آخر — الحساب يعمل على جهاز واحد في المرة',
            }),
          ),
          401,
        ),
      );

      expect(ended, isTrue, reason: 'الجلسة انتهت فعلاً — الشاشة تُبلَّغ');
      expect(api.isLoggedIn, isFalse, reason: 'التوكن يُمسح');
      expect(api.sessionEndedMessage, contains('جهاز آخر'),
          reason: 'السبب يُعرض في شاشة الدخول بدل «جلسة غير صالحة»');
    });

    test('عطل الخادم المؤقت (500) يُبقي الجلسة ولا يطرد أحداً', () async {
      final api = client();
      await api.saveTokens('good-access', 'good-refresh');

      var ended = false;
      api.onSessionEnded = () => ended = true;

      final ok = await api.debugHandleRefreshResponse(
        http.Response('bad gateway', 500),
      );

      expect(ok, isFalse, reason: 'التجديد لم ينجح');
      expect(ended, isFalse, reason: 'لا طرد على عطل مؤقت');
      expect(api.isLoggedIn, isTrue, reason: 'التوكن يبقى للمحاولة التالية');
    });

    test('التجديد الناجح يحفظ التوكنين الجديدين ويُبلّغ الـSocket', () async {
      final api = client();
      await api.saveTokens('old-access', 'old-refresh');

      String? announced;
      api.onTokenRefreshed = (t) => announced = t;

      final ok = await api.debugHandleRefreshResponse(
        http.Response(
          jsonEncode({
            'accessToken': 'new-access',
            'refreshToken': 'new-refresh',
          }),
          200,
        ),
      );

      expect(ok, isTrue);
      expect(api.token, 'new-access');
      expect(announced, 'new-access');

      // ومحفوظان على القرص لا في الذاكرة وحدها.
      final revived = client();
      await revived.loadTokens();
      expect(revived.token, 'new-access');
    });
  });
}
