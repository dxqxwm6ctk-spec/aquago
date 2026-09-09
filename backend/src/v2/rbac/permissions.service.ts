import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaV2Service } from '../database/prisma-v2.service';
import { REDIS } from '../redis/redis.module';

const CACHE_TTL_SECONDS = 60; // تعطيل موظف يسري خلال دقيقة كحد أقصى

/**
 * صلاحيات المستخدم لنطاق معيّن:
 *  - agencyId = null  → أدواره على مستوى المنصة
 *  - agencyId = "..." → أدواره داخل تلك الوكالة فقط (عزل المستأجرين)
 * المصدر قاعدة البيانات، وRedis كاش قصير العمر فقط.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private prisma: PrismaV2Service,
    @Inject(REDIS) private redis: Redis,
  ) {}

  private cacheKey(userId: string, agencyId: string | null): string {
    return `permissions:user:${userId}:${agencyId ?? 'platform'}`;
  }

  async getPermissions(
    userId: string,
    agencyId: string | null,
  ): Promise<Set<string>> {
    const key = this.cacheKey(userId, agencyId);
    try {
      const cached = await this.redis.get(key);
      if (cached) return new Set(JSON.parse(cached));
    } catch {
      /* Redis غير متاح → نقرأ من القاعدة مباشرة */
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, agencyId },
      include: {
        role: {
          include: { permissions: { include: { permission: true } } },
        },
      },
    });
    const keys = new Set<string>();
    for (const ur of userRoles) {
      for (const rp of ur.role.permissions) keys.add(rp.permission.key);
    }

    try {
      await this.redis.set(key, JSON.stringify([...keys]), 'EX', CACHE_TTL_SECONDS);
    } catch {
      /* الكاش تحسين وليس شرطاً */
    }
    return keys;
  }

  /** تُستدعى بعد أي تغيير على أدوار المستخدم ليسري فوراً بدل انتظار الـ TTL */
  async invalidate(userId: string): Promise<void> {
    try {
      const keys = await this.redis.keys(`permissions:user:${userId}:*`);
      if (keys.length) await this.redis.del(...keys);
    } catch {
      /* أسوأ حالة: يسري التغيير بعد 60 ثانية */
    }
  }
}
