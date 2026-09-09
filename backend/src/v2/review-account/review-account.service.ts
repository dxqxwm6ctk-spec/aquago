import { BadRequestException, Injectable } from '@nestjs/common';
import { AppTarget } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { normalizeJordanPhone } from '../common/phone.util';

const TARGETS: AppTarget[] = ['CUSTOMER', 'DRIVER'];

/** أقصر رمز مقبول — أقصر منه يُخمَّن بالقوة الغاشمة مهما ضاق حدّ المحاولات */
const MIN_CODE_LENGTH = 6;

/**
 * حساب مراجعة المتجر: رقم واحد لكل تطبيق يدخل بلا واتساب.
 *
 * كان سابقاً في متغيّرَي البيئة APPLE_REVIEW_PHONE/APPLE_REVIEW_OTP — رقماً
 * واحداً للتطبيقين، وإغلاقه يتطلب لمس Railway. صار صفّاً لكل تطبيق يديره
 * الأدمن من اللوحة، لأن الإغلاق فور قبول التطبيق هو الخطوة التي تُنسى حين
 * تحتاج نشراً: باب مفتوح بعد المراجعة أخطر من غيابه أصلاً.
 */
@Injectable()
export class ReviewAccountService {
  constructor(private prisma: PrismaV2Service) {}

  private assertTarget(app: string): AppTarget {
    if (!TARGETS.includes(app as AppTarget)) {
      throw new BadRequestException('app يجب أن تكون CUSTOMER أو DRIVER');
    }
    return app as AppTarget;
  }

  /**
   * هل هذا دخول مراجعة صالح؟ يناديها مسار التحقق قبل رمز الواتساب.
   *
   * تُفحص التطبيقات كلها لا تطبيقاً بعينه: مسار الدخول واحد مشترك ولا يحمل
   * الطلب أي إشارة إلى التطبيق الذي جاء منه، فربط الرقم بتطبيقه هنا كان
   * سيتطلب حقلاً جديداً في كل نداء دخول. والرقم مقصور أصلاً على من يعرفه.
   */
  async isReviewLogin(phone: string, code: string | undefined): Promise<boolean> {
    const rows = await this.prisma.reviewAccountConfig.findMany({
      where: { enabled: true },
    });
    if (rows.length === 0) return false;

    const normalized = normalizeJordanPhone(phone);
    for (const row of rows) {
      if (normalizeJordanPhone(row.phone) !== normalized) continue;

      // لا رمز مطلوب: الرقم وحده يكفي، بقرار صريح من الأدمن
      if (!row.requireCode) return true;

      // رمز مطلوب: لا بد أن يكون محفوظاً وطويلاً بما يكفي ومطابقاً
      const stored = row.code?.trim();
      if (!stored || stored.length < MIN_CODE_LENGTH) return false;
      if (!code) return false;
      return stored === code.trim();
    }
    return false;
  }

  /**
   * هل نتظاهر بإرسال رمز واتساب لهذا الرقم؟ رقم المراجعة لا يملك واتساب
   * أصلاً، فالإرسال إليه يفشل أو يذهب إلى رقم غريب — نردّ كأن شيئاً أُرسل
   * حتى تسير شاشة التطبيق كما هي عند المراجِع.
   */
  async isReviewPhone(phone: string): Promise<boolean> {
    const rows = await this.prisma.reviewAccountConfig.findMany({
      where: { enabled: true },
      select: { phone: true },
    });
    const normalized = normalizeJordanPhone(phone);
    return rows.some((r) => normalizeJordanPhone(r.phone) === normalized);
  }

  /** للوحة — الصفّان دائماً، حتى ما لم يُنشأ بعد، فتظهر البطاقتان معاً */
  async list() {
    const rows = await this.prisma.reviewAccountConfig.findMany({
      include: { updatedBy: { select: { id: true, name: true } } },
    });
    const byApp = new Map(rows.map((r) => [r.app, r]));
    return TARGETS.map(
      (app) =>
        byApp.get(app) ?? {
          app,
          enabled: false,
          phone: '',
          code: null,
          requireCode: true,
          updatedAt: null,
          updatedByUserId: null,
          updatedBy: null,
        },
    );
  }

  async update(
    app: string,
    dto: {
      enabled?: boolean;
      phone?: string;
      code?: string | null;
      requireCode?: boolean;
    },
    actorUserId: string,
  ) {
    const target = this.assertTarget(app);
    const existing = await this.prisma.reviewAccountConfig.findUnique({
      where: { app: target },
    });

    // القيم بعد التعديل — يُتحقق منها مجتمعةً، لأن الحقل الصالح وحده لا يكفي:
    // «مفعّل + يطلب رمزاً + بلا رمز» ثلاثة حقول صالحة وحالة مكسورة
    const enabled = dto.enabled ?? existing?.enabled ?? false;
    const phone = (dto.phone ?? existing?.phone ?? '').trim();
    const requireCode = dto.requireCode ?? existing?.requireCode ?? true;
    const code =
      dto.code === undefined ? (existing?.code ?? null) : dto.code?.trim() || null;

    if (enabled) {
      if (!phone) {
        throw new BadRequestException('الرقم مطلوب لتفعيل حساب المراجعة');
      }
      if (requireCode && (!code || code.length < MIN_CODE_LENGTH)) {
        throw new BadRequestException(
          `الرمز مطلوب ولا يقل عن ${MIN_CODE_LENGTH} خانات — الأقصر يُخمَّن بالقوة الغاشمة`,
        );
      }
    }

    // الرقم يُخزَّن مطبَّعاً: مقارنته وقت الدخول تُطبِّع الطرفين، لكن تخزينه
    // مطبَّعاً يجعل ما تعرضه اللوحة هو ما يُقارَن فعلاً
    const normalizedPhone = phone ? normalizeJordanPhone(phone) : '';

    return this.prisma.reviewAccountConfig.upsert({
      where: { app: target },
      create: {
        app: target,
        enabled,
        phone: normalizedPhone,
        code,
        requireCode,
        updatedByUserId: actorUserId,
      },
      update: {
        enabled,
        phone: normalizedPhone,
        code,
        requireCode,
        updatedByUserId: actorUserId,
      },
    });
  }
}
