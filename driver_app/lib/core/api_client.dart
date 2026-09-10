import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'device_label.dart';

/// عميل منصة v2: توكن وصول قصير (١٥ دقيقة) + توكن تجديد مُدوَّر (٣٠ يوماً)،
/// مع تجديد تلقائي شفاف عند 401 وإعادة الطلب مرة واحدة.
///
/// التوكنان يُحفظان على القرص: بدونهما يُطلب الدخول في كل فتحة للتطبيق.
class ApiClient {
  ApiClient({String? baseUrl})
      : baseUrl = baseUrl ??
            const String.fromEnvironment(
              'AQUAGO_API_BASE',
              // مضيف الجهاز من محاكي أندرويد. للجهاز الحقيقي مرّر
              // --dart-define=AQUAGO_API_BASE=https://api.example.com
              defaultValue: 'http://10.0.2.2:3000',
            );

  final String baseUrl;

  /// بلا مهلة يبقى الطلب معلّقاً بلا نهاية حين لا يردّ الخادم، فتدور دوّامة
  /// الانتظار في الشاشة إلى الأبد بلا خطأ ولا مخرج.
  static const Duration _requestTimeout = Duration(seconds: 20);

  static const String _accessKey = 'accessToken';
  static const String _refreshKey = 'refreshToken';

  String? _accessToken;
  String? _refreshToken;

  String? get token => _accessToken;

  /// وجود توكن التجديد هو الجلسة — توكن الوصول قد يكون منتهياً وهي حيّة.
  bool get isLoggedIn => _refreshToken != null;

  /// ما يفحصه `PushService` قبل تسجيل توكن الجهاز: مسارات الإشعارات كلها
  /// خلف `JwtV2Guard`.
  bool get isAuthenticated => _accessToken != null && _accessToken!.isNotEmpty;

  /// لماذا انتهت الجلسة آخر مرة — يقوله الخادم (`SESSION_REVOKED_AR`). شاشة
  /// الدخول تعرضه مرة ثم تمسحه. بدونه يجد الزبون نفسه في شاشة الدخول بلا
  /// كلمة: أهو عطل؟ أم أن أحداً يستعمل حسابه؟ الفرق بين الاثنين كبير.
  String? sessionEndedMessage;

  /// الخادم رفض توكن التجديد نفسه: الجلسة انتهت ولا سبيل لإحيائها. تضبطه
  /// طبقة الحالة لتأخذ الزبون إلى شاشة الدخول بالسبب، وإلا بقي أمام تطبيق
  /// يفشل فيه كل نداء صامتاً.
  void Function()? onSessionEnded;

  /// يُنادى بعد كل تجديد ناجح — الـSocket يحمل التوكن في مصافحته، فبلا هذا
  /// يبقى متصلاً بتوكن ميت حتى ينقطع.
  void Function(String accessToken)? onTokenRefreshed;

  Future<void> loadTokens() async {
    final prefs = await SharedPreferences.getInstance();
    _accessToken = prefs.getString(_accessKey);
    _refreshToken = prefs.getString(_refreshKey);
  }

  Future<void> saveTokens(String access, String refresh) async {
    _accessToken = access;
    _refreshToken = refresh;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_accessKey, access);
    await prefs.setString(_refreshKey, refresh);
  }

  /// تسجيل الخروج. **يُبلَّغ الخادم أولاً** ليُلغي الصفّ — مسحُ التوكن محلياً
  /// وحده يترك جلسة حيّة في شاشة «الأجهزة» لدى الأدمن.
  Future<void> clearTokens() async {
    final refresh = _refreshToken;
    if (refresh != null) {
      try {
        await http
            .post(
              _uri('/auth/logout'),
              headers: await _plainHeaders(),
              body: jsonEncode({'refreshToken': refresh}),
            )
            .timeout(_requestTimeout);
      } catch (_) {
        // الخروج محلياً يتمّ ولو تعذّر إبلاغ الخادم — الصفّ ينتهي بمهلته.
      }
    }
    _accessToken = null;
    _refreshToken = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_accessKey);
    await prefs.remove(_refreshKey);
  }

  Future<Map<String, String>> _plainHeaders() async => {
        'Content-Type': 'application/json',
        // بدونها تبدو كل الأجهزة `Dart/3.x (dart:io)` في شاشة «الأجهزة»،
        // فلا يعرف الأدمن أيّها يُخرج.
        'X-Device': await deviceLabel(),
      };

  Future<Map<String, String>> _headers() async => {
        ...await _plainHeaders(),
        if (isAuthenticated) 'Authorization': 'Bearer $_accessToken',
      };

  /// بادئة الخادم `api` (`setGlobalPrefix` في main.ts) ثم إصدار المنصة `v2`.
  Uri _uri(String path) =>
      Uri.parse('$baseUrl/api/v2${path.startsWith('/') ? path : '/$path'}');

  /// لا جلسة محلياً — يُرمى هذا بدل إرسال نداء بلا ترويسة هوية. الخادم يردّ
  /// عليه «توكن مفقود»، وهي رسالة عن حالة داخلية صنعناها نحن لا عن شيء يعني
  /// الزبون، وكانت تظهر له نصّاً في الشاشة.
  static const ApiException _noSession =
      ApiException(401, 'session', 'سجّل دخولك أولاً');

  /// نداءات لا هوية لها أصلاً: الدخول نفسه، وتجديد التوكن، وفحص النسخة.
  ///
  /// القائمة مطابقة لما لا يحمل `JwtV2Guard` على الخادم — لا تخميناً: زيادةُ
  /// مسار هنا تُرسله عارياً فيُردّ، ونقصانُه يمنع الزائر من تصفّح ما له أن
  /// يتصفّحه.
  static bool _needsAuth(String path) =>
      !path.startsWith('/auth/') && !path.startsWith('/app-version/');

  /// للاختبار وحده — القائمة أعلاه عقدٌ مع الخادم يستحق أن يُثبَّت.
  @visibleForTesting
  static bool debugNeedsAuth(String path) => _needsAuth(path);

  /// تجديدٌ واحد في المرة: طلبان يفشلان بـ401 معاً كانا يجدّدان بالتوازي،
  /// فيُدوّر الثاني توكناً ألغاه الأول للتوّ — ويسقط الاثنان.
  Future<bool>? _refreshing;

  Future<bool> _tryRefresh() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<bool> _doRefresh() async {
    final refresh = _refreshToken;
    if (refresh == null) return false;
    final http.Response res;
    try {
      res = await http
          .post(
            _uri('/auth/refresh'),
            headers: await _plainHeaders(),
            body: jsonEncode({'refreshToken': refresh}),
          )
          .timeout(_requestTimeout);
    } catch (_) {
      return false; // الشبكة ساقطة — التوكن يبقى
    }
    return _handleRefreshResponse(res);
  }

  /// ما يُفعل بردّ `/auth/refresh` — مفصولٌ عن النداء نفسه ليُختبر: هذا
  /// التمييز هو ما يمنع طردَ الزبون كلما تعثّرت الشبكة.
  @visibleForTesting
  Future<bool> debugHandleRefreshResponse(http.Response res) =>
      _handleRefreshResponse(res);

  Future<bool> _handleRefreshResponse(http.Response res) async {
    // **التمييز الحاسم**: الخادم رفض التوكن نفسه ← الجلسة انتهت فعلاً. أي
    // فشل آخر (500، بوابة ساقطة) عطل مؤقت: نُبقي التوكن ونفشل هذا الطلب
    // وحده، فمحاولة الزبون التالية بعد دقيقة تنجح بدل أن يجد نفسه مطروداً.
    if (res.statusCode == 401 || res.statusCode == 403) {
      try {
        final body = jsonDecode(bodyOf(res));
        final message = body is Map ? body['message']?.toString() : null;
        if (message != null && message.isNotEmpty) sessionEndedMessage = message;
      } catch (_) {}
      await clearTokens();
      onSessionEnded?.call();
      return false;
    }
    if (res.statusCode >= 400) return false; // عطل مؤقت — التوكن يبقى

    try {
      final body = jsonDecode(bodyOf(res)) as Map<String, dynamic>;
      await saveTokens(
        body['accessToken'] as String,
        body['refreshToken'] as String,
      );
      onTokenRefreshed?.call(body['accessToken'] as String);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> get(String path) =>
      _send(path, (h) => http.get(_uri(path), headers: h), 'GET $path');

  /// نداءٌ يردّ **مصفوفة** لا كائناً (الطلبات، أسباب الإلغاء).
  ///
  /// `_decode` يلفّ المصفوفة في `{'data': […]}` لتوحيد نوع الإرجاع، وقارئها
  /// كان عليه أن يعرف تلك التفصيلة الداخلية ويفكّها في كل موضع — وينساها في
  /// واحد فيقرأ قائمةً فارغة بلا خطأ.
  Future<List<Map<String, dynamic>>> getList(String path) async {
    final res = await get(path);
    final data = res['data'];
    if (data is! List) return const [];
    return data
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) =>
      _send(
        path,
        (h) => http.post(_uri(path), headers: h, body: jsonEncode(body)),
        'POST $path',
      );

  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic> body) =>
      _send(
        path,
        (h) => http.patch(_uri(path), headers: h, body: jsonEncode(body)),
        'PATCH $path',
      );

  Future<Map<String, dynamic>> delete(String path) =>
      _send(path, (h) => http.delete(_uri(path), headers: h), 'DELETE $path');

  Future<Map<String, dynamic>> _send(
    String path,
    Future<http.Response> Function(Map<String, String> headers) request,
    String what, {
    bool retried = false,
  }) async {
    // نداءٌ يحتاج هوية ولا توكن وصول لدينا: نجدّد أولاً إن كانت الجلسة حيّة،
    // وإلا رُدّ هنا بلا رحلة شبكة.
    if (!isAuthenticated && _needsAuth(path)) {
      if (_refreshToken == null) throw _noSession;
      if (!await _tryRefresh()) throw _noSession;
    }
    final res = await request(await _headers()).timeout(_requestTimeout);
    if (res.statusCode == 401 && !retried && _refreshToken != null) {
      if (await _tryRefresh()) {
        return _send(path, request, what, retried: true);
      }
    }
    return _decode(res, what);
  }

  /// يرمي عند أي حالة غير ناجحة: صمت الفشل هنا كان يُظهر جهازاً «مسجَّلاً»
  /// ولا يصله شيء — وهو بالضبط ما تمنعه `PushStatus.registrationFailed`.
  Map<String, dynamic> _decode(http.Response res, String what) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, what, _messageOf(res));
    }
    if (res.bodyBytes.isEmpty) return const {};
    final decoded = jsonDecode(bodyOf(res));
    return decoded is Map<String, dynamic> ? decoded : {'data': decoded};
  }

  /// رسالة Nest العربية إن وُجدت — عرضُ جسم JSON خاماً للزبون ليس رسالة.
  String _messageOf(http.Response res) {
    try {
      final body = jsonDecode(bodyOf(res));
      if (body is Map && body['message'] != null) {
        final m = body['message'];
        return m is List ? m.join('، ') : m.toString();
      }
    } catch (_) {}
    return bodyOf(res);
  }

  /// جسم الردّ مقروءاً **بـUTF-8 دائماً**.
  ///
  /// `res.body` يتّبع `charset` الترويسة ويتراجع إلى latin1 عند غيابها، فرسالة
  /// عربية تصل «Ù...» لا نصّاً — ورسائل الخادم كلها عربية تُعرض للزبون كما هي.
  /// JSON بـUTF-8 بحكم مواصفته، فالقراءة به صحيحة لا تخمين.
  static String bodyOf(http.Response res) {
    try {
      return utf8.decode(res.bodyBytes);
    } catch (_) {
      return res.body;
    }
  }
}

@immutable
class ApiException implements Exception {
  const ApiException(this.statusCode, this.request, this.body);

  final int statusCode;
  final String request;

  /// رسالة الخادم كما تُعرض للزبون.
  final String body;

  String get message => body;

  @override
  String toString() => 'ApiException($statusCode) على $request — $body';
}
