import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/theme/aqua_text.dart';
import '../core/theme/aqua_theme.dart';
import '../state/app_state.dart';

/// بوابة الشروط — تُعرض لمن لم يقبل النسخة السارية.
///
/// **الخادم يقرّر** (`termsAccepted` في `publicUser`): من قَبِل نسخة قديمة
/// يُسأل من جديد، فالموافقة على نصٍّ آخر ليست موافقة.
class TermsGateScreen extends StatelessWidget {
  const TermsGateScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return _GateScaffold(
      title: 'شروط الاستخدام',
      body: 'قبل أن تبدأ، اطّلع على شروط الاستخدام وسياسة الخصوصية ووافق '
          'عليها. نستخدم رقمك وموقعك لتوصيل مياهك ولا نشاركهما مع طرف ثالث '
          'خارج ما يلزم لإتمام الطلب.',
      action: 'أوافق على الشروط',
      onSubmit: (context) => context.read<AppState>().acceptTerms(),
    );
  }
}

/// بوابة تأكيد الاسم — تُعرض مرة واحدة عند أول دخول.
///
/// الاسم الآتي من جوجل لم يختره أحد لهذه الخدمة: قد يكون بالإنجليزية أو حرفاً
/// واحداً أو كنية لا يعرفها أحد — والسائق ينادي به عند الباب.
class ConfirmNameScreen extends StatefulWidget {
  const ConfirmNameScreen({super.key});

  @override
  State<ConfirmNameScreen> createState() => _ConfirmNameScreenState();
}

class _ConfirmNameScreenState extends State<ConfirmNameScreen> {
  late final TextEditingController _controller =
      TextEditingController(text: context.read<AppState>().userName);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return _GateScaffold(
      title: 'ما الاسم الذي ينادونك به؟',
      body: 'السائق ينادي بهذا الاسم عند الباب، فاكتبه كما تحبّ أن تُنادى.',
      action: 'تأكيد الاسم',
      onSubmit: (context) =>
          context.read<AppState>().confirmName(_controller.text.trim()),
      field: TextField(
        controller: _controller,
        textAlign: TextAlign.right,
        style: AquaText.arabic(size: 16, color: colors.ink),
        decoration: InputDecoration(
          filled: true,
          fillColor: colors.surface,
          hintText: 'اسمك',
          hintStyle: AquaText.arabic(size: 15, color: colors.ink4),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide(color: colors.line),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide(color: colors.line),
          ),
        ),
      ),
    );
  }
}

/// الهيكل المشترك للبوابتين: عنوان، شرح، حقل اختياري، زرّ واحد.
///
/// الخطأ يُعرض هنا ولا يُبتلع: بوابة تفشل صامتة تترك الزبون يضغط زرّاً لا
/// يحدث شيئاً.
class _GateScaffold extends StatefulWidget {
  const _GateScaffold({
    required this.title,
    required this.body,
    required this.action,
    required this.onSubmit,
    this.field,
  });

  final String title;
  final String body;
  final String action;
  final Future<void> Function(BuildContext context) onSubmit;
  final Widget? field;

  @override
  State<_GateScaffold> createState() => _GateScaffoldState();
}

class _GateScaffoldState extends State<_GateScaffold> {
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onSubmit(context);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'تعذّر إتمام العملية — أعد المحاولة');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Scaffold(
      backgroundColor: colors.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              Text(
                widget.title,
                style: AquaText.arabic(
                  size: 22,
                  weight: FontWeight.w700,
                  color: colors.ink,
                ),
              ),
              const SizedBox(height: 10),
              Text(
                widget.body,
                style: AquaText.arabic(size: 13.5, color: colors.ink2, height: 1.6),
              ),
              if (widget.field != null) ...[
                const SizedBox(height: 20),
                widget.field!,
              ],
              const Spacer(),
              if (_error != null)
                Container(
                  margin: const EdgeInsets.only(bottom: 14),
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: colors.dangerBg,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: AquaText.arabic(size: 12.5, color: colors.dangerFg, height: 1.5),
                  ),
                ),
              Material(
                color: colors.deep,
                borderRadius: BorderRadius.circular(16),
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: _busy ? null : _submit,
                  child: Container(
                    height: 54,
                    alignment: Alignment.center,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : Text(
                            widget.action,
                            style: AquaText.arabic(
                              size: 15,
                              weight: FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
