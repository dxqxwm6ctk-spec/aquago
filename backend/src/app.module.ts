import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { V2Module } from './v2/v2.module';

// النظام القديم (auth/orders/admin/drivers/catalog/payments/tracking v1) أُزيل
// من هنا بعد تأكيد أن customer_app وdriver_app واللوحات كلها تنادي /api/v2
// حصرياً — إبقاء مسارات API بلا مستخدم حقيقي وبمعدل تدقيق أقل هو السطح
// الخطر، لا حذفها. الكود لا يزال بـ backend/src/{auth,orders,admin,...}
// لمرجعية تاريخية حتى تأكيد عدم الحاجة له نهائياً.
/**
 * **لماذا `serveRoot` مضبوط و`renderPath` معطَّل:**
 *
 * `ServeStaticModule` مصمَّم لتطبيق صفحة واحدة (SPA): يسجّل مساراً جامعاً
 * (`renderPath`، افتراضه `*`) يردّ `index.html` الجذر على **كل** مسار لا
 * يطابق شيئاً، ليتولّى موجّه العميل بقيةَ العمل.
 *
 * لكن `public/` هنا ليست SPA — هي ثمانية أدلّة مستقلّة (admin، agency،
 * platform، app، apply، privacy، support، terms) لكلٍّ `index.html`
 * خاصّ، **ولا `index.html` في الجذر**. فكان المسار الجامع يستدعي
 * `res.sendFile()` على ملفٍ غير موجود، فيرمي ENOENT يمرّ إلى مرشّح
 * الاستثناءات فيصير **500 على كل مسار غير معروف** — بما فيها `/random`
 * و`/api/v2/nonexistent` و`/images/`. مقيسٌ لا مستنتَج.
 *
 * الأثر أبعد من رمز خاطئ: كل 404 كان يُحسب 5xx، فيلوّث تنبيه «أخطاء 5xx
 * مرتفعة» (deployment/observability.md) — عميلٌ قديم ينادي مساراً محذوفاً
 * يبدو عطلَ خادم. وهو تضليل لأي فحص أمني أيضاً.
 *
 * `renderPath` إلى مسارٍ لا يطابق شيئاً يُلغي المسار الجامع عملياً، فتبقى
 * `express.static` وحدها: تخدم الملفات الموجودة (والأدلّة ذات
 * `index.html`) وتُمرّر ما عداها إلى معالج 404 المدمج في Nest.
 */
@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'public'),
      exclude: ['/api*', '/socket.io*'],
      // مسار لا يمكن أن يرد من عميل — تعطيلٌ للسلوك الجامع، لا إعادة توجيه.
      renderPath: '/__spa_fallback_disabled__',
    }),
    V2Module,
  ],
})
export class AppModule {}
