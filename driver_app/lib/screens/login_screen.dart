import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/social_auth.dart';
import '../core/theme/aqua_colors.dart';
import '../core/theme/aqua_text.dart';
import '../core/theme/aqua_theme.dart';
import '../state/driver_state.dart';

/// شاشة الدخول — جوجل أولاً، وآبل على iOS وحده.
///
/// لا كلمة مرور هنا: حسابات اللوحات وحدها تدخل باسم مستخدم وكلمة مرور، ومن
/// اللوحة على الكمبيوتر لا من التطبيق (`finishLogin` يرفض ذلك على الخادم).
class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final state = context.watch<DriverState>();

    // سبب انتهاء الجلسة الماضية — يُعرض مرة ثم يُمسح. بدونه يجد الزبون نفسه
    // هنا بلا كلمة: أهو عطل؟ أم أن أحداً يستعمل حسابه؟
    final ended = state.api.sessionEndedMessage;

    return Scaffold(
      backgroundColor: colors.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Center(
                child: Container(
                  width: 84,
                  height: 84,
                  decoration: const BoxDecoration(
                    gradient: AquaColors.markGradient,
                    shape: BoxShape.circle,
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    'AQ',
                    style: AquaText.numeric(
                      size: 26,
                      weight: FontWeight.w700,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 22),
              Text(
                'تطبيق سائق Aqua Go',
                textAlign: TextAlign.center,
                style: AquaText.arabic(
                  size: 24,
                  weight: FontWeight.w700,
                  color: colors.ink,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'سجّل دخولك لتبدأ ورديتك وتستقبل الطلبات.',
                textAlign: TextAlign.center,
                style: AquaText.arabic(size: 13.5, color: colors.ink2, height: 1.5),
              ),
              const Spacer(),
              if (ended != null) _Notice(text: ended, colors: colors, danger: false),
              if (state.authError != null)
                _Notice(text: state.authError!, colors: colors, danger: true),
              _SignInButton(
                label: 'المتابعة بحساب Google',
                icon: Icons.g_mobiledata,
                busy: state.signingIn,
                filled: true,
                colors: colors,
                onTap: () => context.read<DriverState>().loginWithGoogle(),
              ),
              if (appleSignInAvailable) ...[
                const SizedBox(height: 12),
                _SignInButton(
                  label: 'المتابعة بحساب Apple',
                  icon: Icons.apple,
                  busy: state.signingIn,
                  filled: false,
                  colors: colors,
                  onTap: () => context.read<DriverState>().loginWithApple(),
                ),
              ],
              const SizedBox(height: 18),
              Text(
                'حسابك يعمل على جهاز واحد في المرة — الدخول من جهاز آخر يُخرجك من هذا.',
                textAlign: TextAlign.center,
                style: AquaText.arabic(size: 11.5, color: colors.ink4, height: 1.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// رسالة فوق الأزرار: سبب انتهاء الجلسة (محايدة) أو خطأ دخول (حمراء).
class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.colors, required this.danger});

  final String text;
  final AquaColors colors;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: danger ? colors.dangerBg : colors.infoBg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: AquaText.arabic(
          size: 12.5,
          color: danger ? colors.dangerFg : colors.infoFg,
          height: 1.5,
        ),
      ),
    );
  }
}

class _SignInButton extends StatelessWidget {
  const _SignInButton({
    required this.label,
    required this.icon,
    required this.busy,
    required this.filled,
    required this.colors,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool busy;
  final bool filled;
  final AquaColors colors;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fg = filled ? Colors.white : colors.ink;
    return Opacity(
      // الأزرار تُعطَّل أثناء الدخول فلا يُفتح مساران معاً.
      opacity: busy ? 0.6 : 1,
      child: Material(
        color: filled ? colors.deep : colors.surface,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: busy ? null : onTap,
          child: Container(
            height: 54,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: filled ? null : Border.all(color: colors.line),
            ),
            child: busy
                ? SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2, color: fg),
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(icon, color: fg, size: 22),
                      const SizedBox(width: 8),
                      Text(
                        label,
                        style: AquaText.arabic(
                          size: 14.5,
                          weight: FontWeight.w600,
                          color: fg,
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}
