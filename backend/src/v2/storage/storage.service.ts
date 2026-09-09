import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export interface StoredObject {
  /** المفتاح المخزَّن في القاعدة — لا رابطاً كاملاً ولا مساراً على القرص */
  key: string;
  mimeType: string;
  sizeBytes: number;
}

/** أول قيمة معرَّفة من بين أسماء متعددة لنفس المتغيّر */
function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * تخزين الملفات — واجهة واحدة أمام مزوّدين.
 *
 * **لماذا الآن لا صورة قارورة واحدة:** أربعة مخازن في القاعدة تحمل بايتات
 * حقيقية (`UploadedImage`، `AgencyOnboardingDocument`، `ContractDocument`،
 * `ContractSignature.signatureImage`) لا واحد. الفحص الأول ذكر `UploadedImage`
 * فقط؛ البقية وثائق محروسة (هوية، سجل تجاري، عقود موقّعة) خلف مسارات صلاحية
 * لا مسار علني — والفرق يهم: نفس التخزين، سياسة وصول مختلفة عند القراءة.
 *
 * **`STORAGE_PROVIDER=local` للتطوير — لا اختيار افتراضي صامت.** بيئة بلا
 * القيمة تفشل عند الإقلاع: خادم إنتاج ظنّ نفسه محلياً يكتب على قرص الحاوية
 * ويفقد كل ملف عند إعادة النشر — وهذا بالضبط العطل الذي تُصلحه هذه الوحدة.
 *
 * `local` يكتب تحت `STORAGE_LOCAL_PATH` (افتراضي: `./storage-dev`) خارج
 * `dist/` و`public/` عمداً — الأول يُمحى عند كل `nest build`، والثاني يُخدَّم
 * علناً فيكشف وثائق محروسة. المسار داخل `.gitignore` و`.dockerignore`.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: 'local' | 's3';
  private readonly localRoot: string;
  private s3?: S3Client;
  private bucket = '';
  private publicBaseUrl?: string;

  constructor() {
    const raw = (process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
    if (raw !== 'local' && raw !== 's3') {
      throw new Error(
        `STORAGE_PROVIDER=${process.env.STORAGE_PROVIDER} غير معروف — القيم المقبولة: local | s3. ` +
          'محلياً استعمل local، وعلى DigitalOcean استعمل s3 (متوافق مع Spaces).',
      );
    }
    this.provider = raw;
    this.localRoot = process.env.STORAGE_LOCAL_PATH || join(process.cwd(), 'storage-dev');

    if (this.provider === 's3') {
      // اسمان لكل متغيّر: `S3_*` (المعياري، وما تستعمله وثائق النشر) و
      // `STORAGE_S3_*` (ما نُشر به سابقاً). قبول الاثنين يعني أن ترقية
      // الصورة لا تتطلب تعديل متغيّرات بيئة قائمة على Railway في نفس
      // اللحظة — وهذا شرط عملي لنشرٍ بلا انقطاع، لا ترفٌ توافقي.
      const endpoint = env('S3_ENDPOINT', 'STORAGE_S3_ENDPOINT');
      const region = env('S3_REGION', 'STORAGE_S3_REGION') || 'us-east-1';
      const bucket = env('S3_BUCKET', 'STORAGE_S3_BUCKET');
      const accessKeyId = env('S3_ACCESS_KEY', 'STORAGE_S3_ACCESS_KEY');
      const secretAccessKey = env('S3_SECRET_KEY', 'STORAGE_S3_SECRET_KEY');
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          'STORAGE_PROVIDER=s3 يحتاج S3_ENDPOINT وS3_BUCKET وS3_ACCESS_KEY ' +
            'وS3_SECRET_KEY (أو أسماءها القديمة STORAGE_S3_*).',
        );
      }
      this.bucket = bucket;
      this.publicBaseUrl = env('S3_PUBLIC_URL', 'STORAGE_S3_PUBLIC_URL')?.replace(/\/+$/, '');
      this.s3 = new S3Client({
        endpoint,
        region,
        credentials: { accessKeyId, secretAccessKey },
        // Spaces (وأي مزوّد متوافق مع S3 غير AWS) يحتاج هذا صراحة: بلا
        // النمط المساري يبني SDK رابطاً بأسلوب AWS الافتراضي (subdomain
        // للحاوية) لا يطابق مخطط Spaces.
        forcePathStyle: true,
      });
    }
    this.logger.log(`تخزين الملفات: ${this.provider}`);
  }

  /**
   * حفظ ملف جديد — مفتاح عشوائي دائماً، فلا تعارض بين رفعتين ولا حاجة
   * لتنظيف الاسم الأصلي (قد يحمل محارف عربية أو رموزاً غير صالحة كمسار).
   */
  async put(data: Buffer, mimeType: string, prefix: string): Promise<StoredObject> {
    const key = `${prefix}/${randomUUID()}`;
    if (this.provider === 'local') {
      const full = join(this.localRoot, key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
    } else {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: mimeType,
        }),
      );
    }
    return { key, mimeType, sizeBytes: data.length };
  }

  async get(key: string): Promise<Buffer> {
    if (this.provider === 'local') {
      return readFile(join(this.localRoot, key));
    }
    const res = await this.s3!.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /**
   * رابط عام مباشر — للاستعمال حين تكون السياسة نفسها «عام بلا حراسة»
   * (صور اللوحة القديمة). الوثائق المحروسة لا تستعمل هذه: تمرّ ببايتاتها
   * عبر مسار Nest محروس بصلاحية دائماً، لا رابط تخزين مباشر.
   */
  publicUrl(key: string): string | null {
    if (this.provider === 'local' || !this.publicBaseUrl) return null;
    return `${this.publicBaseUrl}/${key}`;
  }

  /** لا تُستدعى إلا بعد تأكّد الطبقة الأعلى أن لا مرجع آخر لهذا المفتاح */
  async delete(key: string): Promise<void> {
    if (this.provider === 'local') {
      await rm(join(this.localRoot, key), { force: true });
      return;
    }
    await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * هل المفتاح موجود؟ — `HeadObject` لا `GetObject`: الأولى تجلب البيانات
   * الوصفية وحدها، فلا تُنزّل ملفاً بحجم ميغابايتات لتجيب بنعم أو لا.
   *
   * أي خطأ يعني «غير موجود» لا «تعذّر الفحص» عمداً: المستدعي الوحيد المتوقَّع
   * هو تحقّقٌ قبل عملية، وخطأ شبكة عابر يجب ألا يبدو كتأكيد وجود.
   */
  async exists(key: string): Promise<boolean> {
    if (this.provider === 'local') {
      try {
        await stat(join(this.localRoot, key));
        return true;
      } catch {
        return false;
      }
    }
    try {
      await this.s3!.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  // ==================== أسماء الواجهة المعيارية ====================
  // نفس التنفيذ بأسماء وثيقة النشر (upload/download/getUrl). الأسماء
  // الأصلية (put/get/publicUrl) تبقى هي المستعملة داخل الشيفرة القائمة —
  // إعادة تسمية ٢٠ موضع استدعاء لأجل التسمية وحدها تغييرٌ بلا مكسب.

  /** @see put */
  upload(data: Buffer, mimeType: string, prefix: string): Promise<StoredObject> {
    return this.put(data, mimeType, prefix);
  }

  /** @see get */
  download(key: string): Promise<Buffer> {
    return this.get(key);
  }

  /** @see publicUrl */
  getUrl(key: string): string | null {
    return this.publicUrl(key);
  }
}
