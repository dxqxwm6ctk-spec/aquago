import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma-v2/client';
import * as QRCode from 'qrcode';
import { PrismaV2Service } from '../database/prisma-v2.service';

export interface PaymentAccountInput {
  method: PaymentMethod;
  holderNameAr: string;
  accountNumber: string;
  paymentLink?: string | null;
  bankNameAr?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

/**
 * حسابات المنصة المستقبِلة لتحويلات شحن الرصيد.
 *
 * الوكالة كانت تختار "كليك" أو "تحويل بنكي" بلا أن تعرف لوين تحوّل، فيصير
 * الرقم يُتداول برسائل خارج النظام. هنا تُعرَّف الحسابات مرة واحدة من لوحة
 * المنصة وتظهر للوكالة عند اختيار الطريقة.
 *
 * الترتيب: sortOrder ثم الأقدم — حتى يبقى ترتيب العرض عند الوكالة ثابتاً بين
 * الجلسات ولا يتبدّل الحساب الأول كل مرة.
 */
@Injectable()
export class PaymentAccountsService {
  constructor(private prisma: PrismaV2Service) {}

  private static readonly ORDER: Prisma.PaymentAccountOrderByWithRelationInput[] =
    [{ sortOrder: 'asc' }, { createdAt: 'asc' }];

  /** لوحة المنصة: كل الحسابات بما فيها المعطّلة */
  async listAll() {
    return this.withQr(
      await this.prisma.paymentAccount.findMany({
        orderBy: PaymentAccountsService.ORDER,
      }),
    );
  }

  /** ما تراه الوكالة — المفعّل فقط، ولا يُعرض حساب معطّل بلا سبب */
  async listActive() {
    return this.withQr(
      await this.prisma.paymentAccount.findMany({
        where: { isActive: true },
        orderBy: PaymentAccountsService.ORDER,
      }),
    );
  }

  async create(data: PaymentAccountInput, actorId: string) {
    const clean = this.clean(data);
    this.assertBankNamed(data.method, clean.bankNameAr ?? null);
    const account = await this.prisma.paymentAccount.create({
      data: clean as Prisma.PaymentAccountUncheckedCreateInput,
    });
    await this.audit(actorId, 'create', account.id, undefined, account);
    return this.oneWithQr(account);
  }

  async update(id: string, data: Partial<PaymentAccountInput>, actorId: string) {
    const current = await this.get(id);
    const clean = this.clean(data);
    // الطريقة واسم البنك قد يتغيّر أحدهما وحده — الفحص على القيمة بعد الدمج،
    // وإلا مرّ تحويل بنكي بلا اسم بنك عبر تعديل جزئي
    this.assertBankNamed(
      clean.method ?? current.method,
      clean.bankNameAr !== undefined ? clean.bankNameAr : current.bankNameAr,
    );
    const updated = await this.prisma.paymentAccount.update({
      where: { id },
      data: clean,
    });
    await this.audit(actorId, 'update', id, current, updated);
    return this.oneWithQr(updated);
  }

  async remove(id: string, actorId: string) {
    const account = await this.get(id);
    await this.prisma.paymentAccount.delete({ where: { id } });
    await this.audit(actorId, 'delete', id, account, undefined);
    return { id, deleted: true };
  }

  async get(id: string) {
    const account = await this.prisma.paymentAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('الحساب غير موجود');
    return account;
  }

  /**
   * المسافات الزائدة حول رقم حساب أو IBAN تُفشل النسخ واللصق عند الوكالة،
   * فتُقلَّم هنا مرة واحدة بدل أن يتعامل معها كل عرض على حدة.
   */
  private clean(data: Partial<PaymentAccountInput>) {
    const out: Partial<PaymentAccountInput> = { ...data };
    if (out.holderNameAr !== undefined) out.holderNameAr = out.holderNameAr.trim();
    if (out.accountNumber !== undefined) {
      out.accountNumber = out.accountNumber.replace(/\s+/g, ' ').trim();
    }
    if (out.paymentLink !== undefined) out.paymentLink = out.paymentLink?.trim() || null;
    if (out.bankNameAr !== undefined) out.bankNameAr = out.bankNameAr?.trim() || null;
    return out;
  }

  /**
   * ما يُرمَّز في الـQR: الرابط إن وُجد وإلا رقم الحساب/اللقب. الرابط أولاً
   * لأن مسحه يفتح تطبيق الدفع، بينما الرقم يعطي نصاً يُنسخ يدوياً.
   *
   * ملاحظة: هذا QR نصّي عام وليس QR كليك الرسمي (EMVCo/JoPACC) — تطبيق البنك
   * لن يعبّئ المبلغ تلقائياً. يحتاج ذلك مواصفات وتسجيل تاجر لدى JoPACC.
   */
  private qrValue(account: { accountNumber: string; paymentLink: string | null }) {
    return account.paymentLink || account.accountNumber;
  }

  /**
   * معاينة قبل الحفظ للوحة المنصة. تمرّ بنفس المولّد والخيارات التي تراها
   * الوكالة — معاينة بمولّد آخر قد تُظهر رمزاً يختلف عمّا يُمسح فعلاً.
   */
  previewQr(input: { accountNumber?: string; paymentLink?: string | null }) {
    const value = this.qrValue({
      accountNumber: input.accountNumber?.trim() || '',
      paymentLink: input.paymentLink?.trim() || null,
    });
    if (!value) throw new BadRequestException('لا قيمة لترميزها');
    return this.oneWithQr({ accountNumber: value, paymentLink: null }).then((r) => ({
      qrValue: value,
      qrDataUri: r.qrDataUri,
    }));
  }

  /**
   * الـQR يُولَّد عند القراءة لا يُخزَّن: قيمته مشتقّة بالكامل من الحساب،
   * فتخزينه يخلق نسخة ثانية قد تتخلّف عن الرقم بعد تعديله.
   */
  private async oneWithQr<T extends { accountNumber: string; paymentLink: string | null }>(
    account: T,
  ) {
    const value = this.qrValue(account);
    // فشل التوليد لا يمنع عرض الحساب — الرقم وحده يكفي للتحويل
    const qrDataUri = await QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    }).catch(() => null);
    return { ...account, qrValue: value, qrDataUri };
  }

  private withQr<T extends { accountNumber: string; paymentLink: string | null }>(
    accounts: T[],
  ) {
    return Promise.all(accounts.map((a) => this.oneWithQr(a)));
  }

  /** تحويل بنكي بلا اسم بنك حساب بلا فائدة — الوكالة ما بتعرف لأي بنك تروح */
  private assertBankNamed(method: PaymentMethod, bankNameAr: string | null) {
    if (method === 'BANK_TRANSFER' && !bankNameAr) {
      throw new BadRequestException('اسم البنك مطلوب للتحويل البنكي');
    }
  }

  /**
   * تغيير رقم حساب يحوّل أموال الوكالات لوجهة أخرى — أخطر تعديل بالمالية،
   * فيُسجَّل بالقيمتين القديمة والجديدة ومَن غيّرها.
   */
  private audit(
    actorUserId: string,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    oldValue?: unknown,
    newValue?: unknown,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: `payment_account.${action}`,
        entityType: 'PaymentAccount',
        entityId,
        oldValue: oldValue === undefined ? undefined : (oldValue as Prisma.InputJsonValue),
        newValue: newValue === undefined ? undefined : (newValue as Prisma.InputJsonValue),
      },
    });
  }
}
