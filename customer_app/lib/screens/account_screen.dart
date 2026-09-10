import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../core/theme/aqua_theme.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/ui/app_chrome.dart';
import '../state/app_state.dart';

/// شاشة "الحساب" — بيانات الملف الشخصي، العناوين وطريقة الدفع
/// والاشتراك، إعدادات اللغة والإشعارات والدعم، وتسجيل الخروج.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _ProfileHeader(colors: colors),
              const SizedBox(height: 18),
              _SettingsGroup(colors: colors, rows: [
                _Row3('العناوين المحفوظة', '3 عناوين'),
                _Row3('طريقة الدفع', 'نقدًا عند التسليم'),
                _Row3('اشتراك المياه الأسبوعي', null, pill: 'فعّال'),
              ]),
              const SizedBox(height: 14),
              _SettingsGroup(colors: colors, rows: [
                _Row3('اللغة', 'العربية · English'),
                _Row3('الإشعارات', null, toggleOn: true),
                _Row3('الدعم والمساعدة', '24/7'),
              ]),
              const SizedBox(height: 18),
              Center(
                child: TextButton(
                  // يُبلَّغ الخادم ليُلغي الجلسة — مسحُ التوكن محلياً وحده
                  // يترك جلسة حيّة في شاشة «الأجهزة» لدى الأدمن.
                  onPressed: () => context.read<AppState>().logout(),
                  child: Text('تسجيل الخروج', style: AquaText.arabic(size: 13.5, weight: FontWeight.w600, color: const Color(0xFFDC2626))),
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: Text('Aqua Go v1.0.0 · Amman, JO', style: AquaText.numeric(size: 11, color: colors.ink4)),
              ),
            ],
          ),
        ),
      ),
      bottomNavigationBar: const AppBottomNav(),
    );
  }
}

class _ProfileHeader extends StatelessWidget {
  const _ProfileHeader({required this.colors});
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final name = state.userName;
    final phone = state.userPhone;
    return Row(
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(gradient: AquaColors.markGradient, shape: BoxShape.circle),
          alignment: Alignment.center,
          // أول حرف من اسمه هو لا حرفٌ ثابت — الحساب صار حقيقياً.
          child: Text(
            name.characters.isEmpty ? '؟' : name.characters.first,
            style: AquaText.arabic(size: 20, weight: FontWeight.w700, color: Colors.white),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: AquaText.arabic(size: 17, weight: FontWeight.w700, color: colors.ink)),
              // رقم الهاتف يُعزل بـLTR: مقاطعه تُقلَب داخل سياق RTL
              // فيظهر "6635 9041 7 962+" بدل "+962 7 9041 6635".
              if (phone.isNotEmpty)
                Directionality(
                  textDirection: TextDirection.ltr,
                  child: Text(phone, style: AquaText.numeric(size: 12, color: colors.ink3)),
                ),
            ],
          ),
        ),
        Icon(Icons.edit_outlined, color: colors.ink3, size: 20),
      ],
    );
  }
}

class _Row3 {
  const _Row3(this.label, this.value, {this.pill, this.toggleOn});
  final String label;
  final String? value;
  final String? pill;
  final bool? toggleOn;
}

class _SettingsGroup extends StatelessWidget {
  const _SettingsGroup({required this.colors, required this.rows});
  final AquaColors colors;
  final List<_Row3> rows;

  @override
  Widget build(BuildContext context) {
    return AquaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                border: i < rows.length - 1 ? Border(bottom: BorderSide(color: colors.line)) : null,
              ),
              child: Row(
                children: [
                  Expanded(child: Text(rows[i].label, style: AquaText.arabic(size: 13.5, color: colors.ink))),
                  if (rows[i].pill != null)
                    StatusPill(label: rows[i].pill!, background: colors.infoBg, foreground: colors.infoFg)
                  else if (rows[i].toggleOn != null)
                    _MiniToggle(on: rows[i].toggleOn!, colors: colors)
                  else
                    Text(rows[i].value ?? '', style: AquaText.arabic(size: 12.5, color: colors.ink3)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _MiniToggle extends StatelessWidget {
  const _MiniToggle({required this.on, required this.colors});
  final bool on;
  final AquaColors colors;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 26,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: on ? colors.aqua : colors.line2, borderRadius: BorderRadius.circular(AquaRadii.pill)),
      child: Align(
        alignment: on ? Alignment.centerLeft : Alignment.centerRight,
        child: Container(width: 20, height: 20, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
      ),
    );
  }
}
