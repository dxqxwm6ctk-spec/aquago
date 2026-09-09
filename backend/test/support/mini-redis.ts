import net from 'net';

/**
 * خادم RESP صغير — أوامر النشر/الاشتراك وحدها.
 *
 * سببه أن Docker غير متاح على جهاز التطوير، والاختبار المطلوب (حدثٌ يبثّه
 * العامل فيصل عميلاً موصولاً بحاوية أخرى) لا معنى له بلا Redis حقيقي بين
 * العمليتين. هذا الخادم يتكلم البروتوكول على TCP فعلياً، فـioredis ومحوّل
 * Socket.IO وباعثه يعملون بلا أي تعديل ولا محاكاة داخل الشيفرة المختبَرة.
 *
 * ليس بديلاً عن Redis في الإنتاج ولا في اختبار التكامل الكامل: لا تخزين،
 * ولا انتهاء صلاحية، ولا أوامر عدا ما يحتاجه المحوّل. غرضه إثبات أن رسائل
 * الباعث تصل المحوّل بنفس القناة والصيغة.
 */
export class MiniRedis {
  private server = net.createServer();
  /** قناة → الوصلات المشتركة فيها (نص أو نمط) */
  private subs = new Map<string, Set<net.Socket>>();
  private psubs = new Map<string, Set<net.Socket>>();
  /** كل وصلة حيّة — لا الوصلات المشتركة وحدها. `close()` لا يستدعي ردّه
   * إلا بعد إغلاق كل وصلة، فوصلة لم تشترك بعد (لسه بمرحلة handshake) كانت
   * تُبقي `stop()` معلّقة إلى الأبد. */
  private allSockets = new Set<net.Socket>();
  port = 0;

  async start(): Promise<number> {
    return this.startOn(0);
  }

  /** منفذ محدّد — لاختبار عودة Redis على نفس العنوان بعد انقطاع */
  async startOn(port: number): Promise<number> {
    this.server.on('connection', (sock) => this.onConn(sock));
    await new Promise<void>((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(port, '127.0.0.1', () => res());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    // `server.close()` لا يستدعي ردّه إلا بعد إغلاق كل وصلة حيّة — تدمير
    // الوصلات المشتركة وحدها كان يُبقي وصلة لم تشترك بعد مفتوحة فتُعلَّق
    // `stop()` إلى الأبد. أيضاً لا ننتظر حدث 'close' على كل مقبس (بطيء
    // وغير ضروري هنا) — `destroy()` كافٍ لأن الاختبارات لا تعتمد ترتيب
    // الإغلاق، فقط أن الخادم يتوقف عن الاستماع.
    for (const s of this.allSockets) s.destroy();
    this.allSockets.clear();
    await new Promise<void>((res) => this.server.close(() => res()));
  }

  private onConn(sock: net.Socket) {
    this.allSockets.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('close', () => this.allSockets.delete(sock));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.consumed);
        this.dispatch(sock, parsed.args);
      }
    });
    sock.on('close', () => {
      for (const set of [...this.subs.values(), ...this.psubs.values()]) {
        set.delete(sock);
      }
    });
  }

  private dispatch(sock: net.Socket, args: Buffer[]) {
    const cmd = args[0]?.toString().toUpperCase();
    switch (cmd) {
      case 'PING':
        sock.write('+PONG\r\n');
        break;
      case 'QUIT':
        // لا بد من إغلاق الوصلة فعلياً: الردّ بـ+OK وحده يترك ioredis
        // ينتظر إغلاقاً لا يأتي، فتتعلق `quit()` إلى الأبد.
        sock.write('+OK\r\n');
        sock.end();
        break;
      case 'INFO':
        // ioredis يقرأ إصدار الخادم عند الاتصال
        sock.write(bulk('redis_version:7.0.0\r\n'));
        break;
      case 'SUBSCRIBE':
        for (const ch of args.slice(1)) this.addSub(this.subs, ch, sock, 'subscribe');
        break;
      case 'PSUBSCRIBE':
        for (const ch of args.slice(1)) this.addSub(this.psubs, ch, sock, 'psubscribe');
        break;
      case 'UNSUBSCRIBE':
      case 'PUNSUBSCRIBE': {
        const map = cmd === 'UNSUBSCRIBE' ? this.subs : this.psubs;
        for (const [ch, set] of map) if (set.delete(sock)) void ch;
        sock.write(`*3\r\n$11\r\nunsubscribe\r\n$-1\r\n:0\r\n`);
        break;
      }
      case 'PUBLISH': {
        const ch = args[1];
        const payload = args[2];
        let n = 0;
        for (const s of this.subs.get(ch.toString()) ?? []) {
          s.write(msg('message', [ch, payload]));
          n++;
        }
        for (const [pat, set] of this.psubs) {
          if (!globMatch(pat, ch.toString())) continue;
          for (const s of set) {
            s.write(msg('pmessage', [Buffer.from(pat), ch, payload]));
            n++;
          }
        }
        sock.write(`:${n}\r\n`);
        break;
      }
      default:
        // أوامر أخرى (CLIENT، COMMAND…) — ردّ محايد يكفي لبدء ioredis
        sock.write('+OK\r\n');
    }
  }

  private addSub(
    map: Map<string, Set<net.Socket>>,
    ch: Buffer,
    sock: net.Socket,
    kind: string,
  ) {
    const key = ch.toString();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(sock);
    sock.write(
      `*3\r\n$${kind.length}\r\n${kind}\r\n$${ch.length}\r\n${ch.toString('binary')}\r\n:1\r\n`,
    );
  }
}

/** رسالة نشر: مصفوفة عناصر ثنائية (الحمولة قد تكون ثنائية لا نصاً) */
function msg(kind: string, parts: Buffer[]): Buffer {
  const head = Buffer.from(`*${parts.length + 1}\r\n$${kind.length}\r\n${kind}\r\n`);
  const body = parts.map((p) =>
    Buffer.concat([Buffer.from(`$${p.length}\r\n`), p, Buffer.from('\r\n')]),
  );
  return Buffer.concat([head, ...body]);
}

function bulk(s: string): Buffer {
  return Buffer.from(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
}

/** مطابقة نمط Redis المبسّطة — `*` وحده يكفي للمحوّل */
function globMatch(pattern: string, str: string): boolean {
  const rx = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    's',
  );
  return rx.test(str);
}

/** محلّل RESP للأوامر الواردة — مصفوفات من عناصر ثنائية */
function parseCommand(buf: Buffer): { args: Buffer[]; consumed: number } | null {
  if (buf.length === 0) return null;
  if (buf[0] !== 0x2a) {
    // أمر inline (مثل PING\r\n) — يرسله ioredis أحياناً
    const nl = buf.indexOf('\r\n');
    if (nl < 0) return null;
    const line = buf.subarray(0, nl).toString().trim();
    return { args: line.split(/\s+/).map((a) => Buffer.from(a)), consumed: nl + 2 };
  }
  let i = buf.indexOf('\r\n');
  if (i < 0) return null;
  const count = Number(buf.subarray(1, i).toString());
  let off = i + 2;
  const args: Buffer[] = [];
  for (let n = 0; n < count; n++) {
    if (buf[off] !== 0x24) return null;
    const j = buf.indexOf('\r\n', off);
    if (j < 0) return null;
    const len = Number(buf.subarray(off + 1, j).toString());
    const start = j + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.subarray(start, start + len));
    off = start + len + 2;
  }
  return { args, consumed: off };
}
