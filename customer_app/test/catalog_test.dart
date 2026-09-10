// اختبارات طبقة الكتالوج والطلب — فكّ ما يرسله الخادم فعلاً.
//
// ما تحرسه: حقول `Decimal` في Prisma تصل **نصّاً** لا رقماً (`"2.50"` لا
// `2.5`). قراءتها بـ`as num?` تُعيد `null` بصمت — فتظهر كل الأسعار صفراً
// والمسافات فارغة، بلا خطأ يدلّ على الموضع.
//
// الحكم الصحيح على هذا الملف: **منطقيٌّ خالص على فكّ الحمولة.** الحمولات
// مكتوبة بصيغة الخادم الحقيقية (مقروءةً من `orders-v2.service.ts`
// و`schema.prisma`)، فلا شبكة فيه ولا خادم — وما يُقاس هو التحويل وحده.

import 'package:customer_app/core/catalog.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('BottleType — أرقام Prisma النصّية', () {
    test('السعر والحجم يُقرآن من نصّ Decimal', () {
      final b = BottleType.fromJson(const {
        'id': 'bt-1',
        'nameAr': 'قارورة مياه 18.9 لتر',
        'sizeLiters': '18.9',
        'price': '2.50',
      });

      // هذا هو الفخّ: `as num?` على "2.50" تُعيد null فيصير السعر صفراً.
      expect(b.price, 2.5);
      expect(b.sizeLiters, 18.9);
    });

    test('الأرقام الفعلية تمرّ كما هي', () {
      final b = BottleType.fromJson(const {
        'id': 'bt-2',
        'nameAr': 'عبوة',
        'sizeLiters': 5,
        'price': 1.75,
      });

      expect(b.price, 1.75);
      expect(b.sizeLiters, 5);
    });

    test('الاسم المختصر يُشتقّ من الحجم بلا كسرٍ زائد', () {
      // الكتالوج من الخادم لا يحمل «اسماً مختصراً»، والاسم الكامل يلتفّ
      // ثلاثة أسطر في بطاقةٍ بعرض الثُّلث.
      expect(
        BottleType.fromJson(const {
          'id': 'a', 'nameAr': 'x', 'sizeLiters': '18.9', 'price': '1',
        }).shortName,
        '18.9 لتر',
      );
      expect(
        BottleType.fromJson(const {
          'id': 'b', 'nameAr': 'x', 'sizeLiters': '5', 'price': '1',
        }).shortName,
        '5 لتر', // لا «5.0 لتر»
      );
    });

    test('حقل ناقص لا يُسقط الكتالوج كلّه', () {
      // منتجٌ واحد ناقص الحقول كان سيرمي فتختفي القائمة بأكملها.
      final b = BottleType.fromJson(const {'id': 'bt-3'});
      expect(b.price, 0);
      expect(b.nameAr, 'قارورة');
    });
  });

  group('Address', () {
    test('التفاصيل تُركَّب من الحقول الموجودة وحدها', () {
      final a = Address.fromJson(const {
        'id': 'a1',
        'label': 'البيت',
        'street': 'شارع وصفي التل',
        'building': '24',
        'floor': '3',
        'locName': 'خلدا',
        'lat': 31.99,
        'lng': 35.84,
        'isDefault': true,
        'covered': true,
      });

      expect(a.titleLine, 'البيت · خلدا');
      expect(a.details, 'شارع وصفي التل، بناية 24، طابق 3');
      expect(a.oneLine, 'خلدا · شارع وصفي التل');
    });

    test('غياب البناية والطابق لا يترك فواصل معلّقة', () {
      final a = Address.fromJson(const {
        'id': 'a2',
        'label': 'المكتب',
        'street': 'شارع مكة',
        'lat': 31.9,
        'lng': 35.8,
        'isDefault': false,
        'covered': false,
      });

      expect(a.details, 'شارع مكة');
      // بلا `locName` لا يُختلق اسم منطقة.
      expect(a.titleLine, 'المكتب');
      expect(a.covered, isFalse);
    });
  });

  group('Order', () {
    /// حمولة كما يبنيها `getForUser`: الطلب مع `eta` من `estimateEta`.
    Map<String, dynamic> payload({
      String status = 'DRIVER_ASSIGNED',
      Map<String, dynamic>? eta,
    }) =>
        {
          'id': 'order-uuid-1',
          'code': 'AQ-1042',
          'status': status,
          'total': '5.25',
          'items': [
            {
              'qty': 2,
              'bottleType': {'nameAr': 'قارورة مياه 18.9 لتر'},
            },
          ],
          'eta': ?eta,
        };

    test('المعرّفان مفصولان: المعروض والداخلي', () {
      final o = Order.fromJson(payload());

      // `code` يراه الزبون ويذكره عند الاتصال؛ `id` تُبنى به غرفة التتبّع
      // (`order:{id}`) — والاشتراك بالرقم المعروض يُرفض من الخادم.
      expect(o.code, 'AQ-1042');
      expect(o.id, 'order-uuid-1');
    });

    test('الإجمالي من نصّ Decimal', () {
      expect(Order.fromJson(payload()).total, 5.25);
    });

    test('وصف المحتوى يُبنى من بنود الخادم', () {
      expect(Order.fromJson(payload()).itemsLabel, 'قارورة مياه 18.9 لتر × 2');
    });

    test('الـeta يُقرأ حين يصل ويُترك حين يغيب', () {
      final withEta = Order.fromJson(payload(eta: const {
        'minutes': 7,
        'distanceKm': 3.4,
        'viaWarehouse': true,
      }));
      expect(withEta.etaMinutes, 7);
      expect(withEta.distanceKm, 3.4);
      expect(withEta.viaWarehouse, isTrue);

      // `estimateEta` تُعيد null حين لا موقع للسائق — لا رقم مخترع عندها.
      final without = Order.fromJson(payload());
      expect(without.etaMinutes, isNull);
      expect(without.distanceKm, isNull);
    });

    test('حالات الخادم تُخطَّط على مراحل التتبّع الأربع', () {
      // الحالات على الخادم أكثر من المراحل المعروضة؛ التخطيط مرة واحدة هنا
      // بدل أن يفسّر كل موضع في الواجهة حالةً خاماً بطريقته.
      expect(Order.fromJson(payload(status: 'CREATED')).stageIndex, 0);
      expect(Order.fromJson(payload(status: 'AGENCY_ASSIGNED')).stageIndex, 0);
      expect(Order.fromJson(payload(status: 'DRIVER_ASSIGNED')).stageIndex, 1);
      expect(Order.fromJson(payload(status: 'PICKED_UP')).stageIndex, 2);
      expect(Order.fromJson(payload(status: 'DELIVERING')).stageIndex, 2);
      expect(Order.fromJson(payload(status: 'COMPLETED')).stageIndex, 3);
    });

    test('الطلب النشط يُميَّز عن المنتهي', () {
      // بطاقة «طلبك في الطريق» والتتبّع يتبعان هذا: طلبٌ مكتمل أو ملغى
      // يبقى معروضاً لولاه.
      expect(Order.fromJson(payload(status: 'DELIVERING')).isActive, isTrue);
      expect(Order.fromJson(payload(status: 'COMPLETED')).isActive, isFalse);
      expect(Order.fromJson(payload(status: 'CANCELLED')).isActive, isFalse);
    });

    test('طلبٌ بلا code يتراجع إلى المعرّف لا إلى فراغ', () {
      final o = Order.fromJson(const {
        'id': 'order-uuid-9',
        'status': 'CREATED',
        'items': [],
      });
      expect(o.code, 'order-uuid-9');
      expect(o.itemsLabel, 'طلب مياه');
    });
  });
}
