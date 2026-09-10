import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

/// نغمة عرض التوصيل المتكررة (docs/NOTIFICATIONS_GUIDE.md §9.2).
///
/// نغمة القناة رنّةٌ واحدة يقرّرها النظام ولا سبيل لإطالتها، وعرضُ التوصيل
/// مهلته ثوانٍ معدودة — فلا يكفيه ما يكفي خبراً عادياً. التكرار هنا من
/// شيفرة Dart: مشغّلٌ على وضع الحلقة يُوقَف عند الرد أو انقضاء المهلة.
class OfferAlert {
  OfferAlert._();
  static final OfferAlert instance = OfferAlert._();

  AudioPlayer? _player;
  Timer? _stopTimer;

  bool get isPlaying => _player != null;

  /// يبدأ النغمة ويكررها حتى [maxDuration] أو حتى [stop].
  ///
  /// المهلة العليا شبكة أمان لا توقيت: لو ضاع نداء [stop] — انهيار، أو
  /// تجميد النظام لعزل الخلفية — لا تبقى النغمة تدور على جهاز السائق.
  Future<void> start({
    Duration maxDuration = const Duration(seconds: 45),
  }) async {
    if (_player != null) return; // نغمة تدور أصلاً — لا نُراكم مشغّلين

    final player = AudioPlayer();
    _player = player;
    try {
      await player.setReleaseMode(ReleaseMode.loop);
      // نسخة الأصول هي المسموعة والتطبيق مفتوح؛ ونسخة `res/raw` هي التي
      // تعزفها قناة أندرويد. الملفان واحد باسمين — انظر §7.2.
      await player.play(AssetSource('sounds/offer_alert_aquago.mp3'));
      _stopTimer = Timer(maxDuration, stop);
    } catch (e) {
      debugPrint('[offer-alert] تعذّر تشغيل النغمة — $e');
      _player = null;
      await player.dispose();
    }
  }

  /// يوقف النغمة ويحرّر المشغّل — يُستدعى عند الرد على العرض أو رفضه أو
  /// انقضاء مهلته.
  Future<void> stop() async {
    _stopTimer?.cancel();
    _stopTimer = null;
    final player = _player;
    _player = null;
    if (player == null) return;
    try {
      await player.stop();
    } catch (_) {}
    await player.dispose();
  }
}
