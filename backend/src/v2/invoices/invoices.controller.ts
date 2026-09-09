import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import type { User } from '@prisma-v2/client';
import { CurrentUserV2, JwtV2Guard } from '../auth/jwt-v2.guard';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { PlatformService } from '../platform/platform.service';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { InvoicesService, InvoiceViewer } from './invoices.service';

/**
 * كل الحقول اختيارية: اللوحة ترسل ما غيّره الأدمن فقط. `null` صريح يمسح
 * القيمة، وغياب الحقل يتركها كما هي.
 */
class UpdateInvoiceSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsOptional() @IsString() companyNameAr?: string | null;
  @IsOptional() @IsString() companyNameEn?: string | null;
  @IsOptional() @IsString() taxNumber?: string | null;
  @IsOptional() @IsString() licenseNumber?: string | null;
  @IsOptional() @IsString() addressAr?: string | null;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() website?: string | null;
  @IsOptional() @IsString() logoUrl?: string | null;
  @IsOptional() @IsString() financeContact?: string | null;
  @IsOptional() @IsString() footerNoteAr?: string | null;

  @IsOptional() @IsBoolean() showLogo?: boolean;
  @IsOptional() @IsBoolean() showCompanyNameAr?: boolean;
  @IsOptional() @IsBoolean() showCompanyNameEn?: boolean;
  @IsOptional() @IsBoolean() showTaxNumber?: boolean;
  @IsOptional() @IsBoolean() showLicenseNumber?: boolean;
  @IsOptional() @IsBoolean() showAddress?: boolean;
  @IsOptional() @IsBoolean() showPhone?: boolean;
  @IsOptional() @IsBoolean() showEmail?: boolean;
  @IsOptional() @IsBoolean() showWebsite?: boolean;
  @IsOptional() @IsBoolean() showCustomerName?: boolean;
  @IsOptional() @IsBoolean() showCustomerPhone?: boolean;
  @IsOptional() @IsBoolean() showDeliveryAddress?: boolean;
  @IsOptional() @IsBoolean() showAgencyName?: boolean;
  @IsOptional() @IsBoolean() showDriverName?: boolean;
  @IsOptional() @IsBoolean() showCommissionLine?: boolean;
  @IsOptional() @IsBoolean() showDiscountLine?: boolean;
  @IsOptional() @IsBoolean() showFinanceContact?: boolean;
  @IsOptional() @IsBoolean() showFooterNote?: boolean;
  @IsOptional() @IsBoolean() showStamp?: boolean;
}

@Controller('v2/invoices')
@UseGuards(JwtV2Guard, PermissionsGuard)
export class InvoicesController {
  constructor(
    private invoices: InvoicesService,
    private platform: PlatformService,
    private prisma: PrismaV2Service,
  ) {}

  // ---- إعدادات المنصة ----

  @Get('settings')
  @RequirePermissions('platform.invoices.manage')
  settings() {
    return this.invoices.settings();
  }

  @Patch('settings')
  @RequirePermissions('platform.invoices.manage')
  updateSettings(
    @Body() dto: UpdateInvoiceSettingsDto,
    @CurrentUserV2() user: User,
  ) {
    return this.invoices.updateSettings(dto, user.id);
  }

  /** شعار الفاتورة — يُخزَّن في القاعدة كبقية الصور لا على قرص الحاوية */
  @Post('logo')
  @RequirePermissions('platform.invoices.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
        if (!allowed.includes(file.mimetype)) {
          cb(
            new BadRequestException('صيغة صورة غير مدعومة — PNG أو JPEG أو WebP أو SVG'),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadLogo(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('لم يصل أي ملف');
    return this.platform.saveUploadedImage(file.buffer, file.mimetype);
  }

  // ---- المستندات ----
  // تُعاد HTML لا JSON: الطباعة وحفظ PDF من المتصفح مباشرة، وRTL والخطوط
  // العربية تعمل بلا حيلة. لا @RequirePermissions هنا — الوصول يخصّ صاحب
  // المستند (زبون/وكالة) لا صلاحية منصة، ويُفحص داخل الخدمة.

  @Get('order/:orderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async orderInvoice(
    @Param('orderId') orderId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.invoices.orderInvoiceHtml(orderId, await this.viewer(user.id));
  }

  /**
   * رابط دائم لفتح الفاتورة في متصفح الجهاز — يبقيه الزبون على جهازه
   * ويفتحه لاحقاً بلا تسجيل دخول من جديد.
   *
   * التطبيق لا يستطيع فتح مسار محمي بترويسة Authorization في المتصفح، ووضع
   * توكن الدخول في الرابط يسرّبه إلى سجل التصفح والمشاركة. فنولّد رمزاً
   * عشوائياً 256-بت لهذه الفاتورة وحدها (`/invoices/public/<token>`)،
   * نخزّن بصمته فقط لا قيمته، ويبقى صالحاً حتى يُستبدَل بآخر أو يُبطَل.
   * صفحة `/public/<token>` تحوّله لجلسة قصيرة عبر كوكي قبل عرض المستند —
   * راجع InvoicePublicController.
   */
  @Post('order/:orderId/link')
  async orderInvoiceLink(
    @Param('orderId') orderId: string,
    @CurrentUserV2() user: User,
  ) {
    // نتحقق من الصلاحية والحالة الآن لا عند الفتح — الزبون يستحق رسالة
    // واضحة فوراً بدل صفحة خطأ في المتصفح
    await this.invoices.orderInvoiceHtml(orderId, await this.viewer(user.id));
    const token = await this.invoices.createInvoicePublicLink(orderId);
    return { path: `/invoices/public/${token}` };
  }

  /** يبطل الرابط الدائم الحالي لهذا الطلب فوراً — لمن أراد إيقاف مشاركة سابقة */
  @Post('order/:orderId/link/revoke')
  async revokeOrderInvoiceLink(
    @Param('orderId') orderId: string,
    @CurrentUserV2() user: User,
  ) {
    // يتحقق أنه صاحب الطلب فعلاً قبل الإبطال
    await this.invoices.orderInvoiceHtml(orderId, await this.viewer(user.id));
    await this.invoices.revokeInvoicePublicLink(orderId);
    return { ok: true };
  }

  @Get('subscription/:invoiceId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async subscriptionInvoice(
    @Param('invoiceId') invoiceId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.invoices.subscriptionInvoiceHtml(
      invoiceId,
      await this.viewer(user.id),
    );
  }

  @Get('recharge/:requestId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async rechargeReceipt(
    @Param('requestId') requestId: string,
    @CurrentUserV2() user: User,
  ) {
    return this.invoices.rechargeReceiptHtml(
      requestId,
      await this.viewer(user.id),
    );
  }

  /**
   * من يطلب المستند: موظف منصة يرى كل شيء، وغيره لا يرى إلا مستندات وكالاته
   * أو طلباته. يُبنى من الأدوار مباشرة لا من التوكن — دور أُلغي للتو يجب أن
   * يسري الآن لا عند تجديد التوكن.
   */
  private async viewer(userId: string): Promise<InvoiceViewer> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { agencyId: true, role: { select: { scope: true } } },
    });
    return {
      id: userId,
      isPlatform: roles.some((r) => r.role.scope === 'PLATFORM'),
      agencyIds: roles
        .map((r) => r.agencyId)
        .filter((id): id is string => id !== null),
    };
  }
}
