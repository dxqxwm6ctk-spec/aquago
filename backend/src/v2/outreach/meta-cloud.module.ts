import { Module } from '@nestjs/common';
import { MetaCloudProvider } from './meta-cloud.provider';

/**
 * مزوّد Meta وحده في وحدة مستقلة.
 *
 * يستعمله طرفان: حملات التواصل (OutreachV2Module) ورموز التحقق
 * (AuthV2Module) — وإعداد Meta واحد للنظام كله لا إعدادان يفترقان.
 *
 * **ولماذا وحدة منفصلة لا استيراد متبادل**: `OutreachV2Module` تستورد
 * `AuthV2Module` أصلاً (لتأخذ `WhatsappService` — جلسة واتساب واحدة للنظام)،
 * فاستيراد العكس يغلق الحلقة وترفض Nest إقلاع التطبيق كلياً. والمزوّد بلا
 * اعتماديات، فإخراجه إلى وحدته يكسر الحلقة بلا forwardRef ولا التباس في
 * ترتيب التهيئة.
 */
@Module({
  providers: [MetaCloudProvider],
  exports: [MetaCloudProvider],
})
export class MetaCloudModule {}
