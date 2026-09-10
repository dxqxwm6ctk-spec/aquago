import 'package:flutter/foundation.dart';

/// **Decimal في Prisma يصل نصّاً لا رقماً.**
///
/// قراءته بـ`as num?` تُعيد `null` بصمت — فيظهر المبلغ المطلوب تحصيله صفراً
/// أمام السائق، وهو رقمٌ يقبض به من الزبون.
double? _toDouble(Object? v) => switch (v) {
      num n => n.toDouble(),
      String s => double.tryParse(s),
      _ => null,
    };

/// طلبٌ كما يصفه الخادم للسائق.
@immutable
class DriverOrder {
  const DriverOrder({
    required this.id,
    required this.code,
    required this.status,
    required this.items,
    required this.addressText,
    this.total,
    this.notes,
    this.customerName,
    this.customerPhone,
    this.deliveryLat,
    this.deliveryLng,
  });

  factory DriverOrder.fromJson(Map<String, dynamic> json) {
    final customer = json['customer'];
    final items = (json['items'] as List?) ?? const [];
    return DriverOrder(
      id: json['id'] as String,
      code: (json['code'] as String?)?.trim() ?? (json['id'] as String),
      status: (json['status'] as String?) ?? 'DRIVER_ASSIGNED',
      items: items
          .whereType<Map>()
          .map((i) => DriverOrderItem.fromJson(Map<String, dynamic>.from(i)))
          .toList(growable: false),
      addressText: (json['addressText'] as String?)?.trim() ?? '',
      total: _toDouble(json['total']),
      notes: (json['notes'] as String?)?.trim(),
      customerName: customer is Map ? (customer['name'] as String?)?.trim() : null,
      // الرقم يصل مع الطلب المفتوح وحده — سجلّ الخمسين طلباً السابقة يحمل
      // الاسم بلا رقم، فلا يحمل السائق أرقام كل من وصّل لهم.
      customerPhone: customer is Map ? (customer['phone'] as String?)?.trim() : null,
      deliveryLat: _toDouble(json['deliveryLat']),
      deliveryLng: _toDouble(json['deliveryLng']),
    );
  }

  final String id;
  final String code;
  final String status;
  final List<DriverOrderItem> items;
  final String addressText;

  /// المبلغ المطلوب تحصيله نقداً.
  final double? total;

  /// ملاحظة الزبون («اتصل عند الوصول»).
  final String? notes;

  final String? customerName;
  final String? customerPhone;
  final double? deliveryLat;
  final double? deliveryLng;

  /// هل الطلب ما زال مفتوحاً على السائق؟
  bool get isActive => const {
        'DRIVER_ASSIGNED',
        'PICKED_UP',
        'DELIVERING',
      }.contains(status);

  String get itemsLabel => items.isEmpty
      ? 'طلب مياه'
      : items.map((i) => '${i.nameAr} × ${i.qty}').join('، ');

  /// **مرحلة التسليم الأربعية** المقابلة لحالة الخادم.
  ///
  /// كانت المرحلة تتقدّم بضغطةٍ محلية بلا صلة بما يعرفه الخادم — فيرى
  /// السائق «تم التسليم» وحالة الطلب لم تتغيّر، والزبون ينتظر.
  int get stageIndex => switch (status) {
        'DRIVER_ASSIGNED' => 0,
        'PICKED_UP' => 1,
        'DELIVERING' => 2,
        _ => 3,
      };

  /// الحالة التالية في تدفّق السائق — `null` عند نهايته.
  ///
  /// التدفّق يفرضه الخادم (`DRIVER_FLOW`) ويرفض ما خالفه؛ تكراره هنا يمنع
  /// نداءً محكوماً بالرفض ويُبقي الزرّ صادقاً في تسميته.
  String? get nextStatus => switch (status) {
        'DRIVER_ASSIGNED' => 'PICKED_UP',
        'PICKED_UP' => 'DELIVERING',
        'DELIVERING' => 'COMPLETED',
        _ => null,
      };

  /// نصّ زرّ التقدّم بحسب الحالة.
  String? get nextActionLabel => switch (status) {
        'DRIVER_ASSIGNED' => 'حمّلت القوارير',
        'PICKED_UP' => 'انطلقت للزبون',
        'DELIVERING' => 'تم التسليم والتحصيل',
        _ => null,
      };
}

@immutable
class DriverOrderItem {
  const DriverOrderItem({required this.nameAr, required this.qty});

  factory DriverOrderItem.fromJson(Map<String, dynamic> json) {
    final bottle = json['bottleType'];
    return DriverOrderItem(
      nameAr: bottle is Map
          ? ((bottle['nameAr'] as String?)?.trim() ?? 'قارورة')
          : ((json['nameAr'] as String?)?.trim() ?? 'قارورة'),
      qty: (json['qty'] as num?)?.toInt() ?? 1,
    );
  }

  final String nameAr;
  final int qty;
}

/// عرضٌ موجَّه لهذا السائق، بمؤقّت تنازلي.
@immutable
class DriverOffer {
  const DriverOffer({
    required this.id,
    required this.order,
    required this.remainingSeconds,
    this.zone,
  });

  factory DriverOffer.fromJson(Map<String, dynamic> json) {
    return DriverOffer(
      id: json['id'] as String,
      order: DriverOrder.fromJson(
        Map<String, dynamic>.from(json['order'] as Map),
      ),
      // الثواني المتبقّية يحسبها الخادم عند القراءة: ساعةُ الجهاز قد تكون
      // مضبوطة خطأً، فمؤقّتٌ مبنيّ على `expiresAt` وحدها كان ينتهي مبكّراً
      // أو يتأخّر بفارق ساعة الجهاز.
      remainingSeconds: (json['remainingSeconds'] as num?)?.toInt() ?? 0,
      zone: (json['zone'] as String?)?.trim(),
    );
  }

  final String id;
  final DriverOrder order;
  final int remainingSeconds;

  /// اسم المنطقة كما يحلّه الخادم.
  final String? zone;
}

/// إحصائيات السائق كما يوفّرها الخادم.
///
/// **لا أرباح فيها عمداً**: أجرُ السائق تحاسبه وكالته لا المنصة، فالخادم لا
/// يحمل رقماً لها. شاشة الأرباح كانت تعرض «18.750 اليوم» و«96.500 الأسبوع»
/// أرقاماً مخترعة — أخطر ما في التطبيق أن يَعِد سائقاً بمبلغ لا مصدر له.
@immutable
class DriverStats {
  const DriverStats({
    required this.completedToday,
    required this.completedTotal,
    required this.rating,
    required this.ratingCount,
    required this.status,
  });

  factory DriverStats.fromJson(Map<String, dynamic> json) {
    return DriverStats(
      completedToday: (json['completedToday'] as num?)?.toInt() ?? 0,
      completedTotal: (json['completedTotal'] as num?)?.toInt() ?? 0,
      rating: _toDouble(json['rating']),
      ratingCount: (json['ratingCount'] as num?)?.toInt() ?? 0,
      status: (json['status'] as String?) ?? 'OFFLINE',
    );
  }

  final int completedToday;
  final int completedTotal;

  /// `null` قبل أول تقييم — «—» أصدق من «0.0» التي تبدو تقييماً سيئاً.
  final double? rating;

  final int ratingCount;

  /// `AVAILABLE` / `BUSY` / `OFFLINE` كما يعرفها الخادم.
  final String status;

  String get ratingLabel => rating == null ? '—' : rating!.toStringAsFixed(1);
}
