import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma-v2/client';
import type { LeadSourceType } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { AgencyLeadsService, type LeadInput } from './agency-leads.service';
import { findDuplicate } from './duplicate-detection.util';

/** أعمدة الملف — بالعربية أو الإنجليزية، فمصادر البيانات تأتي بالاثنتين */
const COLUMN_ALIASES: Record<string, keyof LeadInput> = {
  name: 'name',
  'الاسم': 'name',
  businessname: 'businessName',
  'الاسم التجاري': 'businessName',
  phone: 'phoneNumber',
  phonenumber: 'phoneNumber',
  'الهاتف': 'phoneNumber',
  'رقم الهاتف': 'phoneNumber',
  whatsapp: 'whatsappNumber',
  whatsappnumber: 'whatsappNumber',
  'واتساب': 'whatsappNumber',
  altphone: 'alternativePhoneNumber',
  alternativephonenumber: 'alternativePhoneNumber',
  'هاتف بديل': 'alternativePhoneNumber',
  area: 'areaName',
  areaname: 'areaName',
  'المنطقة': 'areaName',
  neighborhood: 'neighborhood',
  'الحي': 'neighborhood',
  address: 'address',
  'العنوان': 'address',
  lat: 'latitude',
  latitude: 'latitude',
  lng: 'longitude',
  longitude: 'longitude',
  licensenumber: 'licenseNumber',
  'رقم الترخيص': 'licenseNumber',
  licensesource: 'licenseSource',
  licensestatus: 'licenseStatus',
  'حالة الترخيص': 'licenseStatus',
  source: 'dataSource',
  datasource: 'dataSource',
  'المصدر': 'dataSource',
  sourceurl: 'sourceUrl',
  url: 'sourceUrl',
  externalid: 'externalId',
  placeid: 'externalId',
  notes: 'notes',
  'ملاحظات': 'notes',
};

const SOURCE_TYPES: LeadSourceType[] = [
  'GOOGLE_MAPS',
  'OFFICIAL_WEBSITE',
  'FACEBOOK',
  'INSTAGRAM',
  'PUBLIC_DIRECTORY',
  'GOVERNMENT_SOURCE',
  'MANUAL',
  'OTHER',
];

interface RowError {
  row: number;
  reason: string;
}

/**
 * استيراد الوكالات المحتملة.
 *
 * **قاعدتان لا تُكسران:**
 *  1. كل صفٍّ مستورَد ينتهي عند `PENDING_REVIEW`. لا راية ولا عمود في الملف
 *     يجعله معتمداً — الاعتماد قرار إداري بشري لاحق.
 *  2. الاستيراد **لا يرسل رسالة واحدة**. لا استدعاء لبوابة واتساب من هنا،
 *     ولا إدراج في طابور. الرسائل تبدأ من حملة يبدأها إنسان بعد معاينة.
 */
@Injectable()
export class LeadImportService {
  private readonly logger = new Logger(LeadImportService.name);

  constructor(
    private prisma: PrismaV2Service,
    private leads: AgencyLeadsService,
  ) {}

  /**
   * يبدأ دفعة ويعيد معرّفها فوراً. المعالجة تكمل في الخلفية: ملف بآلاف
   * الأسطر لا يُبقي طلب HTTP معلقاً حتى تنتهي، والحالة تُتابَع من
   * GET /imports/:id.
   */
  async start(
    rows: Record<string, unknown>[],
    fileName: string | undefined,
    actorId: string,
  ) {
    if (!rows.length) throw new BadRequestException('لا صفوف في الملف');
    if (rows.length > 20_000) {
      throw new BadRequestException('الحد الأقصى 20000 صف في الدفعة الواحدة');
    }

    const batch = await this.prisma.agencyLeadImport.create({
      data: {
        fileName: fileName ?? null,
        status: 'PENDING',
        totalRows: rows.length,
        startedById: actorId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'lead.import.start',
        entityType: 'AgencyLeadImport',
        entityId: batch.id,
        newValue: { fileName: fileName ?? null, totalRows: rows.length },
      },
    });

    // بلا await: الطلب يعود بمعرّف الدفعة، والمعالجة تكمل خلفه
    void this.process(batch.id, rows, actorId).catch((e) =>
      this.logger.error(`فشلت دفعة الاستيراد ${batch.id}: ${e}`),
    );
    return batch;
  }

  private async process(
    importId: string,
    rows: Record<string, unknown>[],
    actorId: string,
  ) {
    await this.prisma.agencyLeadImport.update({
      where: { id: importId },
      data: { status: 'PROCESSING' },
    });

    let created = 0;
    let updated = 0;
    let duplicates = 0;
    let skipped = 0;
    const errors: RowError[] = [];

    for (const [i, raw] of rows.entries()) {
      const rowNumber = i + 1;
      try {
        const input = this.mapRow(raw);
        if (!input.name?.trim()) {
          skipped++;
          errors.push({ row: rowNumber, reason: 'صف بلا اسم — لا يُستورَد' });
          continue;
        }

        const dup = await findDuplicate(this.prisma, input);
        if (dup.kind === 'certain') {
          // تطابق مؤكد: نكمل الفراغات فقط ولا نكتب فوق شيء موجود
          const before = dup.lead;
          const after = await this.leads.fillBlanksFrom(before.id, input);
          if (input.externalId || input.sourceUrl) {
            await this.recordSource(before.id, input);
          }
          duplicates++;
          if (after && this.changed(before, after)) updated++;
          continue;
        }

        await this.leads.create(input, actorId, importId);
        created++;
      } catch (e) {
        errors.push({
          row: rowNumber,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const status =
      errors.length === 0
        ? 'COMPLETED'
        : created + updated + duplicates > 0
          ? 'PARTIAL'
          : 'FAILED';

    const batch = await this.prisma.agencyLeadImport.update({
      where: { id: importId },
      data: {
        status,
        created,
        updated,
        duplicates,
        skipped,
        errors: errors.length,
        // سقف على السجل: ملف كله خاطئ لا يجوز أن يخزّن ميغابايتات في صفّ
        errorLog: errors.slice(0, 500) as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actorId,
        action: 'lead.import.complete',
        entityType: 'AgencyLeadImport',
        entityId: importId,
        newValue: { status, created, updated, duplicates, skipped, errors: errors.length },
      },
    });
    this.logger.log(
      `دفعة ${importId}: ${status} — أُنشئ ${created}، حُدّث ${updated}، مكرر ${duplicates}، متخطّى ${skipped}، أخطاء ${errors.length}`,
    );
    return batch;
  }

  private changed(before: { updatedAt: Date }, after: { updatedAt: Date }) {
    return before.updatedAt.getTime() !== after.updatedAt.getTime();
  }

  private async recordSource(leadId: string, input: LeadInput) {
    if (!input.externalId && !input.sourceUrl) return;
    // مصدر إضافي لنفس السجل — القيد الفريد يمنع تكرار نفس (النوع، المعرّف)
    await this.prisma.agencyDataSource
      .create({
        data: {
          leadId,
          sourceType: input.dataSource ?? 'OTHER',
          sourceUrl: input.sourceUrl ?? null,
          externalId: input.externalId ?? null,
        },
      })
      .catch(() => undefined);
  }

  /**
   * يحوّل صفاً خاماً إلى مدخل نظيف.
   *
   * **لا يخترع شيئاً**: عمود غائب أو فارغ يصير `null`، وحالة ترخيص غير
   * مفهومة تصير `UNKNOWN` لا `UNLICENSED`، ومصدر غير معروف يصير `MANUAL`.
   */
  private mapRow(raw: Record<string, unknown>): LeadInput {
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const alias = COLUMN_ALIASES[key.trim().toLowerCase()];
      if (!alias) continue;
      const v = typeof value === 'string' ? value.trim() : value;
      if (v === '' || v === undefined || v === null) continue;
      mapped[alias] = v;
    }

    const num = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
      return Number.isFinite(n) ? n : null;
    };

    const rawLicense = String(mapped.licenseStatus ?? '').toUpperCase();
    const licenseStatus =
      rawLicense === 'LICENSED' ||
      rawLicense === 'UNLICENSED' ||
      rawLicense === 'PENDING_VERIFICATION'
        ? (rawLicense as LeadInput['licenseStatus'])
        : 'UNKNOWN';

    const rawSource = String(mapped.dataSource ?? '')
      .toUpperCase()
      .replace(/[\s-]/g, '_');
    const dataSource = SOURCE_TYPES.includes(rawSource as LeadSourceType)
      ? (rawSource as LeadSourceType)
      : 'MANUAL';

    return {
      name: String(mapped.name ?? ''),
      businessName: (mapped.businessName as string) ?? null,
      phoneNumber: (mapped.phoneNumber as string) ?? null,
      whatsappNumber: (mapped.whatsappNumber as string) ?? null,
      alternativePhoneNumber: (mapped.alternativePhoneNumber as string) ?? null,
      areaName: (mapped.areaName as string) ?? null,
      neighborhood: (mapped.neighborhood as string) ?? null,
      address: (mapped.address as string) ?? null,
      latitude: num(mapped.latitude),
      longitude: num(mapped.longitude),
      licenseStatus,
      licenseNumber: (mapped.licenseNumber as string) ?? null,
      licenseSource: (mapped.licenseSource as string) ?? null,
      dataSource,
      sourceUrl: (mapped.sourceUrl as string) ?? null,
      externalId: (mapped.externalId as string) ?? null,
      notes: (mapped.notes as string) ?? null,
    };
  }

  list() {
    return this.prisma.agencyLeadImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { startedBy: { select: { id: true, name: true } } },
    });
  }

  async get(id: string) {
    const batch = await this.prisma.agencyLeadImport.findUnique({
      where: { id },
      include: { startedBy: { select: { id: true, name: true } } },
    });
    if (!batch) throw new NotFoundException('دفعة الاستيراد غير موجودة');
    return batch;
  }

  /**
   * مُحلِّل CSV بسيط يحترم الاقتباس المزدوج — العناوين تحوي فواصل كثيراً،
   * و`split(',')` كان سيقطعها نصفين ويزيح كل الأعمدة بعدها.
   */
  static parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }

    const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
    if (!header) return [];
    return body.map((cells) =>
      Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])),
    );
  }
}
