import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { StorageService } from '../storage/storage.service';

/**
 * تقديم صور رفعها الأدمن — بلا حراسة دخول عمداً: تطبيقا الزبون والسائق
 * يعرضانها لأي مستخدم، لا لموظفي المنصة وحدهم.
 *
 * `immutable`: رابط الصورة يحمل معرّفاً عشوائياً جديداً مع كل رفع (لا يُعاد
 * استخدامه لمحتوى مختلف)، فهذا المحتوى بعينه لن يتغير أبداً تحت هذا الرابط
 * — يخزّنه المتصفح/التطبيق محلياً بلا إعادة تحقق من الخادم في كل مرة.
 *
 * `storageKey` أولاً ثم `data`: صفوف ما قبل مخزن الكائنات لا تملك مفتاحاً
 * بعد، وتبقى تُقرأ من القاعدة حتى تُرحَّل — لا تُكسَر صورة قديمة بهذا التغيير.
 */
@Controller('v2/media')
export class MediaController {
  constructor(
    private prisma: PrismaV2Service,
    private storage: StorageService,
  ) {}

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const image = await this.prisma.uploadedImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('الصورة غير موجودة');
    const data = image.storageKey
      ? await this.storage.get(image.storageKey)
      : image.data;
    if (!data) throw new NotFoundException('الصورة غير موجودة'); // صف فاسد نظرياً فقط
    res.set({
      'Content-Type': image.mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.send(data);
  }
}
