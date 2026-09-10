import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';

import '../core/catalog.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/theme/aqua_theme.dart';
import '../core/ui/aqua_map.dart';
import '../state/app_state.dart';

/// **ورقة العناوين** — اختيار عنوان أو إضافة واحد.
///
/// ورقةٌ سفلية لا شاشةً ثامنة: الشاشات السبع مبنيّة عن التصميم الأصلي،
/// والعنوان يُختار في سياق الطلب لا كوجهةٍ مستقلة يُنتقل إليها.
///
/// وجودها شرطٌ لأن يطلب زبونٌ جديد أصلاً: `POST /orders` يشترط `addressId`،
/// ولم يكن في التطبيق ما يُنشئ عنواناً — العناوين تُقرأ ولا تُكتب.
Future<void> showAddressSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => ChangeNotifierProvider.value(
      value: context.read<AppState>(),
      child: const _AddressSheet(),
    ),
  );
}

class _AddressSheet extends StatefulWidget {
  const _AddressSheet();

  @override
  State<_AddressSheet> createState() => _AddressSheetState();
}

class _AddressSheetState extends State<_AddressSheet> {
  bool _adding = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final state = context.watch<AppState>();

    return Container(
      // يرتفع فوق لوحة المفاتيح: حقولٌ تختفي تحتها تجعل النموذج غير قابل
      // للإكمال على شاشة هاتف صغيرة.
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: colors.line2,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                _adding ? 'عنوان جديد' : 'اختر عنوان التوصيل',
                style: AquaText.arabic(size: 16, weight: FontWeight.w700, color: colors.ink),
              ),
              const SizedBox(height: 14),
              if (_adding)
                _AddressForm(
                  colors: colors,
                  onDone: () => setState(() => _adding = false),
                )
              else
                _AddressList(
                  state: state,
                  colors: colors,
                  onAdd: () => setState(() => _adding = true),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AddressList extends StatelessWidget {
  const _AddressList({
    required this.state,
    required this.colors,
    required this.onAdd,
  });

  final AppState state;
  final AquaColors colors;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.addresses.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 20),
            child: Text(
              'لا عناوين محفوظة — أضف عنوانك لتستقبل طلبك.',
              textAlign: TextAlign.center,
              style: AquaText.arabic(size: 13, color: colors.ink3),
            ),
          )
        else
          for (final a in state.addresses)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _AddressRow(
                address: a,
                selected: state.selectedAddress?.id == a.id,
                colors: colors,
                onTap: () {
                  state.selectAddress(a);
                  Navigator.of(context).pop();
                },
              ),
            ),
        const SizedBox(height: 4),
        GestureDetector(
          onTap: onAdd,
          behavior: HitTestBehavior.opaque,
          child: Container(
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: colors.aqua),
              borderRadius: BorderRadius.circular(AquaRadii.button),
            ),
            child: Text(
              '+ إضافة عنوان',
              style: AquaText.arabic(size: 13.5, weight: FontWeight.w700, color: colors.deep),
            ),
          ),
        ),
      ],
    );
  }
}

class _AddressRow extends StatelessWidget {
  const _AddressRow({
    required this.address,
    required this.selected,
    required this.colors,
    required this.onTap,
  });

  final Address address;
  final bool selected;
  final AquaColors colors;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      // العنوان خارج التغطية لا يُختار: الخادم يرفض الطلب عليه، فاختيارُه
      // يقود الزبون إلى رفضٍ لم يفعل شيئاً ليستحقّه.
      onTap: address.covered ? onTap : null,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: selected ? colors.sky050 : colors.surface,
          border: Border.all(
            color: selected ? colors.aqua : colors.line,
            width: selected ? 1.5 : 1,
          ),
          borderRadius: BorderRadius.circular(AquaRadii.card),
        ),
        child: Row(
          children: [
            Icon(
              Icons.location_on_outlined,
              size: 20,
              color: address.covered ? colors.deep : colors.ink4,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    address.titleLine,
                    style: AquaText.arabic(
                      size: 13.5,
                      weight: FontWeight.w700,
                      color: address.covered ? colors.ink : colors.ink3,
                    ),
                  ),
                  Text(
                    address.details,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AquaText.arabic(size: 11.5, color: colors.ink3),
                  ),
                  if (!address.covered)
                    Text(
                      'خارج نطاق التغطية حالياً',
                      style: AquaText.arabic(size: 11, color: colors.warningStrong),
                    ),
                ],
              ),
            ),
            if (selected) Icon(Icons.check_circle, color: colors.aqua, size: 20),
          ],
        ),
      ),
    );
  }
}

/// نموذج العنوان الجديد — الحقول الأربعة الإلزامية والموقع على الخريطة.
class _AddressForm extends StatefulWidget {
  const _AddressForm({required this.colors, required this.onDone});

  final AquaColors colors;
  final VoidCallback onDone;

  @override
  State<_AddressForm> createState() => _AddressFormState();
}

class _AddressFormState extends State<_AddressForm> {
  final _label = TextEditingController(text: 'البيت');
  final _street = TextEditingController();
  final _building = TextEditingController();
  final _floor = TextEditingController();
  final _notes = TextEditingController();

  /// موقع العنوان — يبدأ من مركز التغطية ويُحرَّك بضغطة على الخريطة.
  LatLng _point = AmmanCoords.center;

  /// نقص الحقول يُعرض هنا لا يُرسَل: الخادم يردّ رسائل تحقّق إنجليزية
  /// (`building should not be empty`) لا تعني الزبون شيئاً.
  String? _localError;

  @override
  void dispose() {
    for (final c in [_label, _street, _building, _floor, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final state = context.read<AppState>();
    final label = _label.text.trim();
    final street = _street.text.trim();
    final building = _building.text.trim();
    final floor = _floor.text.trim();

    if (label.isEmpty || street.isEmpty || building.isEmpty || floor.isEmpty) {
      setState(() => _localError = 'الاسم والشارع والبناية والطابق مطلوبة');
      return;
    }
    setState(() => _localError = null);

    final ok = await state.addAddress(
      label: label,
      street: street,
      building: building,
      floor: floor,
      notes: _notes.text,
      lat: _point.latitude,
      lng: _point.longitude,
    );
    if (!mounted) return;
    // تُغلق الورقة عند النجاح وحده: إغلاقها على كل حال كان يُخفي سبب الرفض
    // ويترك الزبون يظنّ أن العنوان حُفظ.
    if (ok) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final colors = widget.colors;
    final state = context.watch<AppState>();
    final error = _localError ?? state.addressError;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // الموقع يُحدَّد على الخريطة لا يُكتب: العنوان النصّي وحده لا يقود
        // سائقاً، والتغطية تُحسب من الإحداثيات على الخادم.
        Stack(
          children: [
            AquaMap(
              height: 150,
              center: _point,
              zoom: 14,
              markers: [
                AquaMapMarker(
                  point: _point,
                  icon: Icons.location_on_rounded,
                  color: colors.deep,
                ),
              ],
              onTap: (p) => setState(() => _point = p),
            ),
            Positioned(
              right: 8,
              bottom: 8,
              child: MapBadge(label: 'اضغط على الخريطة لتحديد موقعك'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        _Field(controller: _label, hint: 'اسم العنوان (البيت، المكتب)', colors: colors),
        _Field(controller: _street, hint: 'الشارع', colors: colors),
        Row(
          children: [
            Expanded(child: _Field(controller: _building, hint: 'رقم البناية', colors: colors)),
            const SizedBox(width: 10),
            Expanded(child: _Field(controller: _floor, hint: 'الطابق', colors: colors)),
          ],
        ),
        _Field(controller: _notes, hint: 'ملاحظات للسائق (اختياري)', colors: colors),
        if (error != null) ...[
          const SizedBox(height: 4),
          Text(
            error,
            style: AquaText.arabic(size: 12, color: colors.dangerFg),
          ),
        ],
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: GestureDetector(
                onTap: widget.onDone,
                behavior: HitTestBehavior.opaque,
                child: Container(
                  height: 48,
                  alignment: Alignment.center,
                  child: Text(
                    'رجوع',
                    style: AquaText.arabic(size: 13.5, color: colors.ink3),
                  ),
                ),
              ),
            ),
            Expanded(
              flex: 2,
              child: GestureDetector(
                onTap: state.savingAddress ? null : _save,
                behavior: HitTestBehavior.opaque,
                child: Container(
                  height: 48,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: AquaColors.buttonGradient,
                    borderRadius: BorderRadius.circular(AquaRadii.button),
                  ),
                  child: state.savingAddress
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            valueColor: AlwaysStoppedAnimation(Colors.white),
                          ),
                        )
                      : Text(
                          'حفظ العنوان',
                          style: AquaText.arabic(size: 13.5, weight: FontWeight.w700, color: Colors.white),
                        ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.controller, required this.hint, required this.colors});

  final TextEditingController controller;
  final String hint;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        controller: controller,
        style: AquaText.arabic(size: 13.5, color: colors.ink),
        decoration: InputDecoration(
          hintText: hint,
          hintStyle: AquaText.arabic(size: 13, color: colors.ink4),
          filled: true,
          fillColor: colors.bg,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AquaRadii.sm),
            borderSide: BorderSide(color: colors.line),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AquaRadii.sm),
            borderSide: BorderSide(color: colors.line),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AquaRadii.sm),
            borderSide: BorderSide(color: colors.aqua),
          ),
        ),
      ),
    );
  }
}
