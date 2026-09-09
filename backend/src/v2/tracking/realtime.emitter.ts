import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { REDIS_PUB } from '../redis/redis.module';

/** ما تحتاجه طرق البث: نداء `.to(room).emit(event, payload)` لا أكثر */
export interface RoomTarget {
  emit(event: string, ...args: unknown[]): unknown;
}

/**
 * قناة البث الموحّدة — تحلّ مشكلة «العامل لا يملك خادم Socket.IO».
 *
 * **لماذا المحوّل وحده لا يكفي:** المحوّل يربط خوادم Socket.IO ببعضها، لكن
 * عملية العامل (`ROLE=worker`) تقلع بـ`createApplicationContext` بلا خادم
 * أصلاً — فـ`@WebSocketServer()` لا يُحقن و`this.server` يبقى `undefined`.
 * وكل طرق البث كانت تكتب `this.server?.to(...)`، أي أن البثّ من العامل كان
 * **يسقط بصمت**: لا خطأ، لا سجل، ولا حدث يصل السائق. مؤقّت العرض ينتهي في
 * العامل، و`offer:closed` لا يخرج، فيبقى نموذج العرض معلقاً على الجهاز.
 *
 * `Emitter` يكتب على قناة Redis نفسها التي يقرأها المحوّل بنفس البروتوكول،
 * فيصل الحدث إلى الحاوية التي تملك الوصلة — بلا خادم HTTP في العامل.
 *
 * القيود المقصودة: الباعث ينشر فقط. لا `fetchSockets` ولا استقبال أحداث —
 * وهذا كافٍ لأن العامل يبثّ ولا يقرأ حالة الوصلات.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private emitter: Emitter;

  constructor(@Inject(REDIS_PUB) redis: Redis) {
    // نفس النطاق `/v2` الذي يعلنه TrackingV2Gateway — الاسم جزء من مفتاح
    // القناة، واختلافه يعني بثّاً لا يصل أحداً.
    this.emitter = new Emitter(redis).of('/v2');
  }

  /**
   * الخادم المحلي إن وُجد، وإلا الباعث عبر Redis.
   *
   * على الـAPI نُفضّل الخادم المحلي: نفس النتيجة (المحوّل ينشر للبقية) بلا
   * ترميز إضافي، ويُبقي سلوك النسخة الواحدة في التطوير كما كان تماماً.
   */
  to(server: Server | undefined, rooms: string | string[]): RoomTarget {
    if (server) return server.to(rooms);
    return this.emitter.to(rooms);
  }
}
