import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import type { ServerOptions, Server } from 'socket.io';
import { REDIS_PUB, REDIS_SUB } from '../redis/redis.module';

/**
 * محوّل Socket.IO فوق Redis — ما يجعل حاويتَي API قناةً واحدة.
 *
 * بلا هذا المحوّل تحتفظ كل حاوية بغرفها في ذاكرتها وحدها: سائق موصول بـ
 * API#1 لا يصله عرضٌ بُثّ من API#2، فيبقى الطلب في SEARCHING بلا خطأ واحد
 * في السجل. المحوّل ينشر كل بثّ على قناة Redis، فتسلّمه الحاوية التي تملك
 * الوصلة فعلياً.
 *
 * يُطبَّق على كل الأسماء (`createIOServer` يضبط المحوّل على مستوى الخادم)،
 * فيغطي النطاق الافتراضي و`/v2` معاً بلا إعداد لكل واحد.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private app: INestApplicationContext) {
    super(app);
  }

  /**
   * يُستدعى قبل `listen`. العملاء يأتون من حاوية Nest نفسها — لا اتصال
   * رابع ولا تطبيق ioredis ثانٍ، تنفيذاً لشرط «لا تكرّر البنية القائمة».
   */
  connect(): void {
    const pub = this.app.get<Redis>(REDIS_PUB);
    const sub = this.app.get<Redis>(REDIS_SUB);
    this.adapterConstructor = createAdapter(pub, sub);
    this.logger.log('محوّل Socket.IO فوق Redis جاهز');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (!this.adapterConstructor) {
      // لا نُكمل بصمت: خادمٌ بلا محوّل يعمل تماماً على حاوية واحدة ثم يفقد
      // الأحداث عبر الحاويات — أسوأ عطل ممكن، لأنه لا يظهر في التطوير.
      throw new Error('RedisIoAdapter.connect() لم تُستدعَ قبل إنشاء الخادم');
    }
    server.adapter(this.adapterConstructor);
    return server;
  }
}
