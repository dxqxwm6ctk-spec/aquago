import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_client.dart';

/// أين وصل بثّ موقع السائق — حالةٌ معلنة لا صمت.
///
/// السائق يجب أن يعرف أن موقعه يصل فعلاً: زبونٌ ينتظر خريطةً لا تتحرّك،
/// وسائقٌ يحسب أنه يُتتبَّع — كلاهما يكتشف العطل متأخراً. ولأن الإذن قد
/// يُرفض أو تُطفأ خدمة الموقع من النظام، فالسبب يُميَّز لا يُجمع في «فشل».
enum BroadcastStatus {
  /// الوردية مغلقة — لا بثّ.
  off,

  /// جارٍ طلب الإذن أو الوصل.
  starting,

  /// يبثّ فعلاً.
  live,

  /// إذن الموقع مرفوض.
  permissionDenied,

  /// إذن مرفوض نهائياً — لا يُطلب مجدداً إلا من إعدادات النظام.
  permissionDeniedForever,

  /// خدمة الموقع مطفأة على الجهاز.
  locationServiceOff,

  /// القناة منقطعة — الموقع لا يصل.
  disconnected,
}

/// **بثّ موقع السائق** إلى `/v2` عبر Socket.IO.
///
/// الخادم يستقبل `driver:location` منذ البداية، يحفظه على ملفّ السائق،
/// ويحسب الوقت المتبقّي ويوزّعه على غرفة كل طلب نشط
/// (`tracking-v2.gateway.ts`). ولم يكن أحد يرسله: التتبّع كان بنيةً كاملة
/// بلا مصدر.
class LocationBroadcast extends ChangeNotifier {
  LocationBroadcast(this._api);

  final ApiClient _api;

  io.Socket? _socket;
  StreamSubscription<Position>? _positionSub;

  BroadcastStatus status = BroadcastStatus.off;

  /// آخر موقع أُرسل — يُعرض للسائق ليطمئن أن البثّ حيّ.
  Position? lastSent;
  DateTime? lastSentAt;

  bool get isLive => status == BroadcastStatus.live;

  /// **10 أمتار لا كل حركة.** بثٌّ بكل قراءة يستنزف بطارية السائق طوال
  /// الوردية ويغرق الخادم بتحديثات لا تغيّر شيئاً على خريطة الزبون.
  static const _settings = LocationSettings(
    accuracy: LocationAccuracy.high,
    distanceFilter: 10,
  );

  /// يبدأ البثّ — يُنادى عند فتح الوردية.
  Future<void> start() async {
    if (_socket != null) return;
    if (!_api.isAuthenticated) {
      status = BroadcastStatus.disconnected;
      notifyListeners();
      return;
    }

    status = BroadcastStatus.starting;
    notifyListeners();

    if (!await _ensurePermission()) {
      notifyListeners(); // الحالة ضُبطت داخل الفحص
      return;
    }

    // التوكن في `auth`: مصافحة Socket.IO تقرأه من هناك، والترويسة تصل في
    // نقل polling وحده فتسقط المصادقة متى ترقّى الاتصال إلى WebSocket.
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

    // كل مستمع يتحقّق أنه ما زال يخصّ القناة الحالية: نداءات Socket.IO غير
    // متزامنة وتصل بعد الإغلاق، فمستمعٌ متأخّر من قناةٍ أُغلقت كان يُعيد
    // الحالة إلى «يبثّ» بعد أن أنهى السائق ورديته.
    bool isCurrent() => identical(_socket, socket);

    socket.onConnect((_) {
      if (!isCurrent()) return;
      status = BroadcastStatus.live;
      notifyListeners();
      // موقعٌ فور الوصل: `getPositionStream` لا يُصدر شيئاً حتى يتحرّك
      // السائق ١٠ أمتار، فسائقٌ واقف عند المستودع كان يبدو بلا موقع
      // إطلاقاً حتى ينطلق.
      unawaited(_sendCurrent());
    });

    socket.onDisconnect((_) {
      if (!isCurrent()) return;
      if (status == BroadcastStatus.live) {
        status = BroadcastStatus.disconnected;
        notifyListeners();
      }
    });

    socket.onConnectError((e) {
      if (!isCurrent()) return;
      status = BroadcastStatus.disconnected;
      debugPrint('[location] فشل الوصل: $e');
      notifyListeners();
    });

    socket.connect();

    _positionSub = Geolocator.getPositionStream(locationSettings: _settings)
        .listen(_send, onError: (Object e) {
      debugPrint('[location] تدفّق الموقع: $e');
      status = BroadcastStatus.locationServiceOff;
      notifyListeners();
    });
  }

  Future<void> _sendCurrent() async {
    try {
      _send(await Geolocator.getCurrentPosition(locationSettings: _settings));
    } catch (e) {
      debugPrint('[location] تعذّرت قراءة الموقع الحالي: $e');
    }
  }

  void _send(Position p) {
    final socket = _socket;
    if (socket == null || !socket.connected) return;
    socket.emit('driver:location', {'lat': p.latitude, 'lng': p.longitude});
    lastSent = p;
    lastSentAt = DateTime.now();
    if (status != BroadcastStatus.live) status = BroadcastStatus.live;
    notifyListeners();
  }

  /// يفحص الإذن وخدمة الموقع، ويضبط الحالة بسبب الرفض الدقيق.
  Future<bool> _ensurePermission() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      // مطفأة من النظام — لا إذن ينفع هنا، والسائق يحتاج أن يعرف الفرق.
      status = BroadcastStatus.locationServiceOff;
      return false;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.deniedForever) {
      status = BroadcastStatus.permissionDeniedForever;
      return false;
    }
    if (permission == LocationPermission.denied) {
      status = BroadcastStatus.permissionDenied;
      return false;
    }
    return true;
  }

  /// يضبط الحالة يدوياً — للاختبار وحده.
  ///
  /// `geolocator` نداءُ قناةٍ إلى المنصة لا يعمل في بيئة الاختبار، وما
  /// يُقاس هنا هو ما تقوله الشاشة عن كل حالة — وذاك لا يحتاج GPS.
  @visibleForTesting
  void setStatusForTest(BroadcastStatus s) {
    status = s;
    notifyListeners();
  }

  /// يوقف البثّ — عند إغلاق الوردية أو انتهاء الجلسة.
  ///
  /// إيقاف تدفّق الموقع لا القناة وحدها: تدفّقٌ حيّ يُبقي GPS يعمل ويستنزف
  /// البطارية طوال ما بقي التطبيق مفتوحاً، والسائق أغلق ورديته.
  Future<void> stop() async {
    await _positionSub?.cancel();
    _positionSub = null;
    _socket?.dispose();
    _socket = null;
    lastSent = null;
    lastSentAt = null;
    // تعود `off` دائماً — لا بشرط قناة: `start` قد يفشل قبل فتحها (إذن
    // مرفوض، خدمة موقع مطفأة) فيترك حالةً معلنة، وكان الإغلاق يتخطّاها
    // فتبقى الشاشة تقول «إذن الموقع مرفوض» بعد أن أغلق السائق ورديته.
    if (status != BroadcastStatus.off) {
      status = BroadcastStatus.off;
      notifyListeners();
    }
  }

  @override
  void dispose() {
    unawaited(_positionSub?.cancel());
    _socket?.dispose();
    _socket = null;
    super.dispose();
  }
}
