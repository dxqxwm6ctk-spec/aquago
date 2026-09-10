import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart' show IconData, Icons;

/// **Decimal في Prisma يصل نصّاً لا رقماً.**
///
/// قراءته بـ`as num?` تُعيد `null` بصمت — فتظهر كل الأسعار صفراً والمسافات
/// فارغة، بلا خطأ يدلّ على الموضع.
double? _toDouble(Object? v) => switch (v) {
      num n => n.toDouble(),
      String s => double.tryParse(s),
      _ => null,
    };

/// نوع قارورة من كتالوج الخادم (`GET /v2/bottle-types`).
///
/// كان الكتالوج ثلاثة ثوابت في التطبيق: تغييرُ سعرٍ أو إضافةُ حجمٍ يعني نسخةً
/// جديدة في المتجر وانتظارَ مراجعة — بينما الكتالوج يُدار من لوحة المنصة
/// ويتغيّر في يومه.
@immutable
class BottleType {
  const BottleType({
    required this.id,
    required this.nameAr,
    required this.sizeLiters,
    required this.price,
    this.imageUrl,
  });

  factory BottleType.fromJson(Map<String, dynamic> json) {
    return BottleType(
      id: json['id'] as String,
      nameAr: (json['nameAr'] as String?)?.trim() ?? 'قارورة',
      sizeLiters: _toDouble(json['sizeLiters']) ?? 0,
      price: _toDouble(json['price']) ?? 0,
      imageUrl: (json['imageUrl'] as String?)?.trim().isNotEmpty == true
          ? json['imageUrl'] as String
          : null,
    );
  }

  final String id;
  final String nameAr;
  final double sizeLiters;
  final double price;
  final String? imageUrl;

  /// اسمٌ مختصر لبطاقة الرئيسية الضيّقة — يُشتقّ من الحجم لا يُكتب يدوياً.
  ///
  /// الكتالوج من الخادم فلا حقل «اسم مختصر» فيه، واسمُ المنتج الكامل
  /// («قارورة مياه 18.9 لتر») يلتفّ ثلاثة أسطر في بطاقة بعرض الثُّلث.
  String get shortName {
    final n = sizeLiters;
    final size = n == n.roundToDouble()
        ? n.toStringAsFixed(0)
        : n.toStringAsFixed(1);
    return '$size لتر';
  }

  /// أيقونة بحسب الحجم — الكتالوج لا يحمل أيقونات، والصورة قد تغيب.
  IconData get icon {
    if (sizeLiters >= 10) return Icons.water_drop_outlined;
    if (sizeLiters >= 4) return Icons.liquor_outlined;
    return Icons.grid_view_rounded;
  }

}

/// عنوان توصيل من الخادم (`GET /v2/addresses`).
@immutable
class Address {
  const Address({
    required this.id,
    required this.label,
    required this.street,
    required this.lat,
    required this.lng,
    required this.isDefault,
    required this.covered,
    this.building,
    this.floor,
    this.notes,
    this.locName,
  });

  factory Address.fromJson(Map<String, dynamic> json) {
    return Address(
      id: json['id'] as String,
      label: (json['label'] as String?)?.trim() ?? 'عنوان',
      street: (json['street'] as String?)?.trim() ?? '',
      building: (json['building'] as String?)?.trim(),
      floor: (json['floor'] as String?)?.trim(),
      notes: (json['notes'] as String?)?.trim(),
      locName: (json['locName'] as String?)?.trim(),
      lat: _toDouble(json['lat']) ?? 0,
      lng: _toDouble(json['lng']) ?? 0,
      isDefault: json['isDefault'] == true,
      // الخادم يحسبها بـST_DWithin على فروع الوكالات: عنوانٌ خارج التغطية
      // يُعرض ولا يُطلب عليه، بدل أن يكتشف الزبون ذلك عند التأكيد.
      covered: json['covered'] == true,
    );
  }

  final String id;
  final String label;
  final String street;
  final String? building;
  final String? floor;
  final String? notes;

  /// اسم المنطقة كما يحلّه الخادم (حيّ/منطقة/محافظة).
  final String? locName;

  final double lat;
  final double lng;
  final bool isDefault;
  final bool covered;

  /// «البيت · خلدا» — عنوان بطاقة الدفع.
  String get titleLine => locName == null ? label : '$label · $locName';

  /// الشارع والبناية والطابق — سطر التفصيل.
  String get details => [
        street,
        if (building?.isNotEmpty == true) 'بناية $building',
        if (floor?.isNotEmpty == true) 'طابق $floor',
      ].where((p) => p.isNotEmpty).join('، ');

  /// سطرٌ واحد لبطاقة الرئيسية الضيّقة.
  String get oneLine => locName == null ? street : '$locName · $street';
}

/// طلبٌ كما يصفه الخادم (`POST /v2/orders`، `GET /v2/orders/:id`).
@immutable
class Order {
  const Order({
    required this.id,
    required this.code,
    required this.status,
    required this.items,
    this.total,
    this.etaMinutes,
    this.distanceKm,
    this.viaWarehouse = false,
    this.driverName,
    this.driverPhone,
    this.deliveryLat,
    this.deliveryLng,
  });

  factory Order.fromJson(Map<String, dynamic> json) {
    final eta = json['eta'];
    final driver = json['driver'];
    final items = (json['items'] as List?) ?? const [];
    return Order(
      id: json['id'] as String,
      // `code` هو ما يراه الزبون ويذكره عند الاتصال؛ `id` معرّف داخلي.
      code: (json['code'] as String?)?.trim() ?? (json['id'] as String),
      status: (json['status'] as String?) ?? 'CREATED',
      items: items
          .whereType<Map>()
          .map((i) => OrderItem.fromJson(Map<String, dynamic>.from(i)))
          .toList(growable: false),
      total: _toDouble(json['total']),
      etaMinutes: eta is Map ? (eta['minutes'] as num?)?.round() : null,
      distanceKm: eta is Map ? _toDouble(eta['distanceKm']) : null,
      viaWarehouse: eta is Map && eta['viaWarehouse'] == true,
      driverName: driver is Map ? (driver['name'] as String?)?.trim() : null,
      driverPhone: driver is Map ? (driver['phone'] as String?)?.trim() : null,
      deliveryLat: _toDouble(json['deliveryLat']),
      deliveryLng: _toDouble(json['deliveryLng']),
    );
  }

  final String id;
  final String code;

  /// حالة الخادم الخام (`CREATED`، `DRIVER_ASSIGNED`، `DELIVERING`…).
  final String status;

  final List<OrderItem> items;
  final double? total;

  final int? etaMinutes;
  final double? distanceKm;
  final bool viaWarehouse;

  final String? driverName;
  final String? driverPhone;

  final double? deliveryLat;
  final double? deliveryLng;

  /// هل الطلب ما زال جارياً؟ ما عداه لا يُتتبَّع ولا تُعرض بطاقته.
  bool get isActive => const {
        'CREATED',
        'AGENCY_ASSIGNED',
        'DRIVER_ASSIGNED',
        'PICKED_UP',
        'DELIVERING',
      }.contains(status);

  /// وصفٌ عربي للمحتوى: «قارورة 18.9 لتر × 2».
  String get itemsLabel => items.isEmpty
      ? 'طلب مياه'
      : items.map((i) => '${i.nameAr} × ${i.qty}').join('، ');

  /// **مرحلة التتبّع الأربعية** المقابلة لحالة الخادم.
  ///
  /// الحالات على الخادم أكثر من المراحل المعروضة: التخطيط هنا مرة واحدة بدل
  /// أن يفسّر كل موضع في الواجهة حالةً خاماً بطريقته.
  int get stageIndex => switch (status) {
        'CREATED' || 'AGENCY_ASSIGNED' => 0,
        'DRIVER_ASSIGNED' => 1,
        'PICKED_UP' || 'DELIVERING' => 2,
        _ => 3,
      };
}

/// بندٌ واحد في الطلب.
@immutable
class OrderItem {
  const OrderItem({required this.nameAr, required this.qty});

  factory OrderItem.fromJson(Map<String, dynamic> json) {
    final bottle = json['bottleType'];
    return OrderItem(
      nameAr: bottle is Map
          ? ((bottle['nameAr'] as String?)?.trim() ?? 'قارورة')
          : ((json['nameAr'] as String?)?.trim() ?? 'قارورة'),
      qty: (json['qty'] as num?)?.toInt() ?? 1,
    );
  }

  final String nameAr;
  final int qty;
}
