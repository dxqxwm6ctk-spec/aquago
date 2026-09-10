/// وجهة الضغطة على إشعار — خريطة واحدة يستعملها إشعار النظام وبطاقة
/// الإشعار داخل التطبيق معاً.
///
/// خريطتان تتباعدان مع الوقت: ضغطة الإشعار تفتح شاشة وبطاقة الوارد تفتح
/// أخرى للنوع نفسه. لذلك القرار هنا وحده، والشاشات تُربط في `main.dart`
/// (docs/NOTIFICATIONS_GUIDE.md §10).
enum NotifDestination { chat, order, support, none }

/// أنواع تخصّ محادثة الدعم مهما حملت من بيانات أخرى.
const _supportTypes = {
  'COMPLAINT_REPLIED',
  'COMPLAINT_RECEIVED',
  'COMPLAINT_CLOSED',
};

/// [hasOrder] و[hasTicket]: هل تحمل بيانات الإشعار معرّف طلب/تذكرة.
NotifDestination notifDestination(
  String type, {
  required bool hasOrder,
  bool hasTicket = false,
}) {
  // تطبيق السائق وحده: عرض التوصيل له طريقه الخاص — ورقة العرض بمهلتها
  // وصوتها — لا شاشة طلبٍ لم يقبله بعد.
  if (type == 'OFFER_RECEIVED') return NotifDestination.none;

  if (type == 'ORDER_MESSAGE') {
    return hasOrder ? NotifDestination.chat : NotifDestination.none;
  }
  if (_supportTypes.contains(type) || hasTicket) return NotifDestination.support;
  // كل ما تبقّى مما يحمل طلباً — قبول، وصول، إلغاء، اكتمال — مكانه شاشة
  // التوصيل الجاري: هي التي تُظهر الحالة وتحمل أزرار التصرّف.
  if (hasOrder) return NotifDestination.order;
  return NotifDestination.none;
}
