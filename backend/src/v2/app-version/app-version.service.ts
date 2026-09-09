import { BadRequestException, Injectable } from '@nestjs/common';
import { AppTarget } from '@prisma-v2/client';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { compareVersions } from '../common/version.util';

const TARGETS: AppTarget[] = ['CUSTOMER', 'DRIVER'];

@Injectable()
export class AppVersionService {
  constructor(private prisma: PrismaV2Service) {}

  private assertTarget(app: string): AppTarget {
    if (!TARGETS.includes(app as AppTarget)) {
      throw new BadRequestException('app يجب أن تكون CUSTOMER أو DRIVER');
    }
    return app as AppTarget;
  }

  /** يستدعيه التطبيق عند الإقلاع — بلا إعداد محفوظ أو معطَّل لا يوجد إجبار */
  async check(app: string, version: string) {
    const target = this.assertTarget(app);
    if (!version) throw new BadRequestException('version مطلوب');
    const cfg = await this.prisma.appVersionConfig.findUnique({ where: { app: target } });
    if (!cfg || !cfg.enabled) return { forceUpdate: false as const };
    return {
      forceUpdate: compareVersions(version, cfg.minVersion) < 0,
      minVersion: cfg.minVersion,
      messageAr: cfg.updateMessageAr,
      downloadUrl: cfg.downloadUrl,
    };
  }

  async list() {
    return this.prisma.appVersionConfig.findMany();
  }

  async update(
    app: string,
    dto: {
      minVersion: string;
      enabled?: boolean;
      updateMessageAr?: string;
      downloadUrl?: string | null;
    },
  ) {
    const target = this.assertTarget(app);
    return this.prisma.appVersionConfig.upsert({
      where: { app: target },
      create: {
        app: target,
        minVersion: dto.minVersion,
        enabled: dto.enabled ?? true,
        ...(dto.updateMessageAr ? { updateMessageAr: dto.updateMessageAr } : {}),
        downloadUrl: dto.downloadUrl ?? null,
      },
      update: {
        minVersion: dto.minVersion,
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.updateMessageAr !== undefined ? { updateMessageAr: dto.updateMessageAr } : {}),
        ...(dto.downloadUrl !== undefined ? { downloadUrl: dto.downloadUrl } : {}),
      },
    });
  }
}
