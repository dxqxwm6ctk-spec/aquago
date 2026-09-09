import { Module } from '@nestjs/common';
import { PlatformV2Module } from '../platform/platform.module';
import { InvoicePublicController } from './invoice-public.controller';
import { InvoiceViewController } from './invoice-view.controller';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

// PlatformV2Module: رفع الشعار يمر بنفس مخزن الصور الذي ترفع إليه بقية
// اللوحة (saveUploadedImage) فلا يتكرر منطق التخزين
@Module({
  imports: [PlatformV2Module],
  // العارض قبل المحمي: مسار /view/:token يجب ألا يلتقطه :orderId
  controllers: [
    InvoicePublicController,
    InvoiceViewController,
    InvoicesController,
  ],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesV2Module {}
