import { ConsoleLogger, type LogLevel } from '@nestjs/common';

/**
 * سجلّ JSON سطرٌ لكل حدث — لأن أي مجمّع سجلّات (Loki، Better Stack،
 * Datadog، سجلّات المنصّة نفسها) يستخرج الحقول من JSON ولا يستخرجها من
 * نصّ ملوّن بمحارف ANSI.
 *
 * **ما كان قبل هذا:** `[Nest] 1 - 09/07/2026, 8:10:51 AM   LOG [Ctx]` مع
 * رموز `\x1b[32m` مغروسة. المجمّع يبتلعه سطراً نصّياً واحداً: لا تصفية
 * بالمستوى، ولا تنبيه على شرط، ولا ربط سطر بطلب. أي تنبيه على «أخطاء
 * 5xx مرتفعة» يحتاج حقلاً اسمه `level` لا لوناً أخضر.
 *
 * **يبقى بشرياً في التطوير عمداً:** JSON على الطرفية أثناء التطوير يبطئ
 * القراءة بلا مقابل — لا مجمّع هناك أصلاً. المعيار `NODE_ENV=production`
 * أو `LOG_FORMAT=json` صراحةً.
 *
 * محايد تجاه المنصّة تماماً: يكتب على stdout/stderr، وكلتا المنصّتين
 * تلتقطهما. لا SDK مزوّد ولا مفتاح API في التطبيق.
 */
export class JsonLogger extends ConsoleLogger {
  private static useJson(): boolean {
    const fmt = (process.env.LOG_FORMAT || '').trim().toLowerCase();
    if (fmt === 'json') return true;
    if (fmt === 'text') return false;
    return process.env.NODE_ENV === 'production';
  }

  /** المستويات المفعّلة — `LOG_LEVEL=warn` يُسكت debug/verbose/log */
  static levels(): LogLevel[] {
    const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
    const min = (process.env.LOG_LEVEL || 'log').trim().toLowerCase() as LogLevel;
    const from = order.indexOf(min);
    return from === -1 ? order.slice(order.indexOf('log')) : order.slice(from);
  }

  private emit(level: LogLevel, message: unknown, context?: string, stack?: string) {
    if (!JsonLogger.useJson()) {
      // السلوك البشري الأصلي بلا تغيير
      switch (level) {
        case 'error': return super.error(message as string, stack, context);
        case 'warn': return super.warn(message as string, context);
        case 'debug': return super.debug(message as string, context);
        case 'verbose': return super.verbose(message as string, context);
        default: return super.log(message as string, context);
      }
    }

    const line = {
      ts: new Date().toISOString(),
      level,
      // الدور في كل سطر: مع تجميع سجلّات الحاويات كلها في مكان واحد،
      // «أي عملية قالت هذا؟» سؤالٌ يُطرح فوراً عند أول عطل.
      role: process.env.ROLE || 'api',
      context: context || undefined,
      msg: typeof message === 'string' ? message : safeStringify(message),
      ...(stack ? { stack } : {}),
    };
    const out = JSON.stringify(line);
    // الأخطاء إلى stderr: بعض المجمّعات تفصل التيارين، وفقدان هذا التمييز
    // يخلط خطأً حقيقياً بسطر معلوماتي.
    if (level === 'error' || level === 'fatal') process.stderr.write(out + '\n');
    else process.stdout.write(out + '\n');
  }

  log(message: unknown, context?: string) { this.emit('log', message, context ?? this.context); }
  warn(message: unknown, context?: string) { this.emit('warn', message, context ?? this.context); }
  debug(message: unknown, context?: string) { this.emit('debug', message, context ?? this.context); }
  verbose(message: unknown, context?: string) { this.emit('verbose', message, context ?? this.context); }

  error(message: unknown, stack?: string, context?: string) {
    this.emit('error', message, context ?? this.context, stack);
  }
}

/** كائن غير قابل للتسلسل (دوري مثلاً) يجب ألا يُسقط سطر سجلّ */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
