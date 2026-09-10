import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_client.dart';
import 'catalog.dart';

/// حالة قناة التتبّع — تُعرض للزبون بدل أن يُترك أمام خريطة ساكنة لا يعرف
/// أهي محدَّثة أم متجمّدة.
///
/// الفرق بين «لا موقع بعد» و«انقطع الاتصال» ليس تفصيلاً: الأولى تعني
/// انتظاراً طبيعياً، والثانية تعني أن ما يراه قديم. خريطةٌ بلا هذا التمييز
/// تعرض آخر موقع وصلها إلى الأبد وتبدو صحيحة.
enum TrackingStatus {
  /// لم تبدأ — لا طلب جارٍ.
  idle,

  /// جارٍ الوصل أو إعادة الوصل.
  connecting,

  /// متّصل، بانتظار أول موقع من السائق.
  waitingForDriver,

  /// متّصل ويصل الموقع.
  live,

  /// انقطع — ما يُعرض قديم.
  disconnected,
}

/// موقع السائق كما وصل من الخادم، مع تقدير الوصول المحسوب هناك.
@immutable
class DriverPosition {
  const DriverPosition({
    required this.point,
    required this.at,
    this.etaMinutes,
    this.distanceKm,
    this.viaWarehouse = false,
  });

  final LatLng point;

  /// وقت الاستلام محلياً — به يُعرف تقادم الموقع.
  final DateTime at;

  /// من `estimateEta` على الخادم — `null` حين لا يمكن التقدير.
  ///
  /// الحساب هناك لا هنا عمداً: نتيجةٌ واحدة يراها كل العملاء، وتُستبدل
  /// بمحرّك توجيه لاحقاً بلا لمس أي تطبيق مثبَّت على جهاز.
  final int? etaMinutes;

  final double? distanceKm;

  /// يمرّ بالمستودع أولاً — يفسّر للزبون طول الوقت رغم قرب المسافة.
  final bool viaWarehouse;
}

/// **قناة التتبّع الحيّ** — تصل بـ`/v2` عبر Socket.IO، تشترك في غرفة الطلب،
/// وتستقبل `driver:location`.
///
/// الخادم كان يبثّ هذا الحدث منذ البداية (`tracking-v2.gateway.ts`) ولا أحد
/// يسمعه: شاشة التتبّع تعرض نقطتين ثابتتين ومسافةً مكتوبة نصّاً «على بعد 2.1
/// كم» لا تتغيّر مهما تحرّك السائق.
class TrackingService extends ChangeNotifier {
  TrackingService(this._api);

  final ApiClient _api;

  io.Socket? _socket;
  String? _orderId;

  TrackingStatus status = TrackingStatus.idle;
  DriverPosition? position;

  /// الطلب كما يصفه الخادم — يُحدَّث مع كل `order:status`.
  ///
  /// حمولة الحدث تحمل الحالة والملاحظة فقط (`{orderId, status, noteAr, at}`)،
  /// فتفاصيلُ ما تغيّر معها — اسم السائق المعيَّن، وقت الوصول الجديد — تُجلب
  /// بقراءةٍ واحدة بعدها. بدونها كانت الشاشة تعرف أن الحالة تبدّلت ولا تعرف
  /// إلى ماذا.
  Order? order;

  /// آخر ملاحظة من الخادم مع تغيّر الحالة («جارٍ البحث عن سائق»…).
  String? statusNote;

  /// سبب آخر عطل — يُعرض للزبون بدل صمتٍ يترك الخريطة ساكنة بلا تفسير.
  String? error;

  bool get isTracking => _orderId != null;

  /// هل الموقع المعروض قديم؟ بثّ السائق دوري، فتأخّرٌ يتجاوز دقيقة يعني
  /// انقطاعاً لم تُعلنه القناة بعد (شبكة هاتفٍ في نفق مثلاً).
  bool get isStale {
    final p = position;
    if (p == null) return false;
    return DateTime.now().difference(p.at) > const Duration(minutes: 1);
  }

  /// يبدأ تتبّع طلب. آمنٌ للنداء المتكرر بالمعرّف نفسه.
  Future<void> start(String orderId) async {
    if (_orderId == orderId && _socket != null) return;
    await stop();
    if (!_api.isAuthenticated) {
      error = 'سجّل دخولك لمتابعة الطلب';
      status = TrackingStatus.disconnected;
      notifyListeners();
      return;
    }

    _orderId = orderId;
    status = TrackingStatus.connecting;
    error = null;
    notifyListeners();

    // التوكن في `auth` لا في ترويسة: مصافحة Socket.IO تقرأه من هناك
    // (`handshake.auth.token` في البوابة)، والترويسة تصل في نقل polling
    // وحده فتسقط المصادقة متى ترقّى الاتصال إلى WebSocket.
    final socket = io.io(
      '${_api.baseUrl}/v2',
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': _api.token})
          .enableReconnection()
          .setReconnectionDelay(2000)
          .disableAutoConnect()
          .build(),
    );
    _socket = socket;

    // **كل مستمع يتحقّق أنه ما زال يخصّ القناة الحالية.** نداءات Socket.IO
    // غير متزامنة وتصل بعد `dispose`: مستمعٌ متأخّر من قناةٍ أُغلقت كان
    // يُعيد ضبط الحالة على قناة ميتة — فتُعلن الشاشة «انقطع الاتصال» بعد أن
    // غادرها الزبون، أو تُظهر تتبّعاً لطلبٍ لم يعد مفتوحاً.
    bool isCurrent() => identical(_socket, socket);

    socket.onConnect((_) {
      if (!isCurrent()) return;
      // الاشتراك بعد كل وصل لا مرة واحدة: إعادة الوصل تُنشئ جلسة جديدة على
      // الخادم لا تعرف شيئاً عن غرف الجلسة السابقة، فبلا هذا يعود الاتصال
      // «ناجحاً» ولا يصل بعده موقعٌ واحد.
      socket.emitWithAck('order:subscribe', {'orderId': _orderId}, ack: (res) {
        if (!isCurrent()) return;
        final ok = res is Map && res['ok'] == true;
        if (!ok) {
          // يرفض الخادم من ليس صاحب الطلب — إعلانُه أصدق من انتظارٍ أبدي.
          error = 'لا يمكن متابعة هذا الطلب';
          status = TrackingStatus.disconnected;
        } else {
          status = position == null
              ? TrackingStatus.waitingForDriver
              : TrackingStatus.live;
          error = null;
          // قراءةٌ أولى فور الاشتراك: الحالة قد تكون تقدّمت قبل أن تُفتح
          // الشاشة (التوزيع يجري في طابور)، فانتظارُ أول حدث كان يعرض
          // مرحلةً قديمة إلى أن يتغيّر شيء.
          unawaited(refreshOrder());
        }
        notifyListeners();
      });
    });

    socket.on('driver:location', (data) {
      if (!isCurrent()) return;
      applyLocationEvent(data);
    });

    socket.on('order:status', (data) {
      if (!isCurrent()) return;
      applyStatusEvent(data);
    });

    socket.onDisconnect((_) {
      if (!isCurrent()) return;
      // لا نمسح `position`: آخر موقع معروف أنفع من خريطة فارغة، والحالة
      // تقول إنه قديم. المسح كان سيُخفي ما يعرفه الزبون فعلاً.
      status = TrackingStatus.disconnected;
      notifyListeners();
    });

    socket.onConnectError((e) {
      if (!isCurrent()) return;
      status = TrackingStatus.disconnected;
      error = 'تعذّر الاتصال بالتتبّع';
      debugPrint('[tracking] فشل الوصل: $e');
      notifyListeners();
    });

    socket.connect();
  }

  /// يطبّق حمولة `driver:location` كما تصل من الخادم.
  ///
  /// مفصولةٌ عن مستمع الـSocket ومكشوفة: هذا هو منطق العرض كله — قراءة
  /// الحمولة وضبط الحالة — ووصلُ Socket حقيقي في الاختبار كان سيحتاج خادماً
  /// ليقيس ما لا علاقة له بالشبكة. المصافحة نفسها تُختبر على جهاز.
  @visibleForTesting
  void applyLocationEvent(dynamic data) {
    if (data is! Map) return;
    final lat = (data['lat'] as num?)?.toDouble();
    final lng = (data['lng'] as num?)?.toDouble();
    if (lat == null || lng == null) return;

    final eta = data['eta'];
    position = DriverPosition(
      point: LatLng(lat, lng),
      at: DateTime.now(),
      etaMinutes: eta is Map ? (eta['minutes'] as num?)?.round() : null,
      distanceKm: eta is Map ? (eta['distanceKm'] as num?)?.toDouble() : null,
      viaWarehouse: eta is Map && eta['viaWarehouse'] == true,
    );
    status = TrackingStatus.live;
    error = null;
    notifyListeners();
  }

  /// يطبّق حمولة `order:status` ثم يعيد جلب الطلب.
  ///
  /// الجلب بعد الحدث لا معه: الحمولة لا تحمل السائق ولا وقت الوصول، وهما ما
  /// يتغيّر فعلاً حين يُعيَّن سائق. وهو ما يجعل شاشة المتابعة تتقدّم وحدها —
  /// قبله كانت تتجمّد على «تم تأكيد الطلب» حتى يُعيد الزبون فتحها.
  @visibleForTesting
  void applyStatusEvent(dynamic data) {
    if (data is! Map) return;
    final status = data['status'];
    if (status is! String) return;
    statusNote = (data['noteAr'] as String?)?.trim();
    notifyListeners();
    unawaited(refreshOrder());
  }

  /// يقرأ الطلب من الخادم — مصدر الحقيقة لحالته وسائقه ووقت وصوله.
  Future<void> refreshOrder() async {
    final id = _orderId;
    if (id == null) return;
    try {
      order = Order.fromJson(await _api.get('/orders/$id'));
      notifyListeners();
    } catch (e) {
      // قراءةٌ فاشلة لا تُفرغ ما نعرفه: الحالة السابقة أنفع من شاشة فارغة،
      // والحدث التالي (أو فتحُ الشاشة) يُصلح ما فات.
      debugPrint('[tracking] تعذّرت قراءة الطلب: $e');
    }
  }

  /// يضبط الطلب يدوياً — للاختبار وحده.
  @visibleForTesting
  void setOrderForTest(Order o) {
    order = o;
    notifyListeners();
  }

  /// يضبط الحالة يدوياً — للاختبار وحده (انقطاع، انتظار، خطأ).
  @visibleForTesting
  void setStatusForTest(TrackingStatus s, {String? message, DateTime? at}) {
    status = s;
    error = message;
    if (at != null && position != null) {
      position = DriverPosition(
        point: position!.point,
        at: at,
        etaMinutes: position!.etaMinutes,
        distanceKm: position!.distanceKm,
        viaWarehouse: position!.viaWarehouse,
      );
    }
    notifyListeners();
  }

  /// يوقف التتبّع ويغلق القناة. تُنادى عند مغادرة الشاشة وانتهاء الطلب:
  /// قناةٌ مفتوحة بلا شاشة تستهلك بطارية وبيانات بلا مستفيد.
  Future<void> stop() async {
    final socket = _socket;
    _socket = null;
    _orderId = null;
    socket?.dispose();
    order = null;
    statusNote = null;

    // الحالة تعود `idle` دائماً — لا بشرط وجود قناة.
    //
    // `start` قد يفشل قبل أن يفتح قناةً أصلاً (بلا جلسة مثلاً) فيترك الحالة
    // `disconnected` و`_orderId` فارغاً؛ عندها كان `stop` يرى «لا قناة» ولا
    // يصفّر شيئاً، فتبقى الشاشة تُعلن انقطاعاً عن تتبّعٍ لم يبدأ ولا يعني
    // الزبونَ بعد أن غادر.
    if (status != TrackingStatus.idle || error != null) {
      status = TrackingStatus.idle;
      error = null;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _socket?.dispose();
    _socket = null;
    super.dispose();
  }
}
