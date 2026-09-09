import { Injectable } from '@nestjs/common';

/**
 * عدّادات في الذاكرة — مصدر `/api/metrics`.
 *
 * **لماذا في الذاكرة لا في Redis:** المقاييس لكل عملية بطبيعتها. حاويتان
 * تعطيان صفَّي مقاييس، والمجمّع يجمعهما — هذا ما تتوقعه أدوات المراقبة
 * (Prometheus وما يوافقه) لا العكس. تجميعها في Redis يخلط الحاويات ويخفي
 * أن واحدة بعينها هي المريضة، ويجعل المقاييس تعتمد على Redis الذي نراقبه.
 *
 * **لماذا لا مكتبة مقاييس:** `prom-client` تضيف اعتمادية وسطح إعداد
 * لأجل ما ينجزه عدّاد وهستوغرام بسيطان هنا. البند ٢٤ يطلب ألّا نفرط في
 * الهندسة، والصيغة أدناه يقرأها Prometheus وما يوافقه بلا وسيط.
 *
 * الذاكرة تُفقد عند إعادة التشغيل — مقبول: المقاييس إشارة اتجاه لا سجلّ
 * محاسبي، والمجمّع يحتفظ بالتاريخ لا العملية.
 */
@Injectable()
export class MetricsService {
  private readonly startedAt = Date.now();

  /** طلبات مكتملة، مفتاحها "METHOD مسار statusClass" */
  private readonly requests = new Map<string, number>();
  /** مجموع أزمنة الاستجابة ومربّعاتها لكل مسار — لحساب المتوسط */
  private readonly durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  /** مهام BullMQ بحسب النتيجة */
  private readonly jobs = new Map<string, number>();

  recordRequest(method: string, route: string, statusCode: number, ms: number) {
    const cls = `${Math.floor(statusCode / 100)}xx`;
    bump(this.requests, `${method} ${route} ${cls}`);
    const d = this.durations.get(route) ?? { count: 0, totalMs: 0, maxMs: 0 };
    d.count++;
    d.totalMs += ms;
    if (ms > d.maxMs) d.maxMs = ms;
    this.durations.set(route, d);
  }

  recordJob(queue: string, outcome: 'completed' | 'failed') {
    bump(this.jobs, `${queue} ${outcome}`);
  }

  /** صيغة نصّية يقرأها Prometheus مباشرة — بلا مكتبة */
  render(): string {
    const role = process.env.ROLE || 'api';
    const lines: string[] = [];

    lines.push('# HELP aquago_uptime_seconds عمر العملية بالثواني');
    lines.push('# TYPE aquago_uptime_seconds gauge');
    lines.push(`aquago_uptime_seconds{role="${role}"} ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);

    lines.push('# HELP aquago_http_requests_total عدد الطلبات المكتملة');
    lines.push('# TYPE aquago_http_requests_total counter');
    for (const [key, n] of this.requests) {
      const [method, route, cls] = key.split(' ');
      lines.push(
        `aquago_http_requests_total{role="${role}",method="${method}",route="${esc(route)}",status="${cls}"} ${n}`,
      );
    }

    lines.push('# HELP aquago_http_duration_ms_avg متوسط زمن الاستجابة لكل مسار');
    lines.push('# TYPE aquago_http_duration_ms_avg gauge');
    lines.push('# HELP aquago_http_duration_ms_max أطول زمن استجابة مسجَّل');
    lines.push('# TYPE aquago_http_duration_ms_max gauge');
    for (const [route, d] of this.durations) {
      lines.push(
        `aquago_http_duration_ms_avg{role="${role}",route="${esc(route)}"} ${(d.totalMs / d.count).toFixed(1)}`,
      );
      lines.push(`aquago_http_duration_ms_max{role="${role}",route="${esc(route)}"} ${d.maxMs}`);
    }

    lines.push('# HELP aquago_jobs_total مهام BullMQ بحسب النتيجة');
    lines.push('# TYPE aquago_jobs_total counter');
    for (const [key, n] of this.jobs) {
      const [queue, outcome] = key.split(' ');
      lines.push(`aquago_jobs_total{role="${role}",queue="${queue}",outcome="${outcome}"} ${n}`);
    }

    return lines.join('\n') + '\n';
  }

  /** لقطة JSON — أسهل قراءةً بشرياً وللوحات لا تتكلم Prometheus */
  snapshot() {
    const byRoute: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
    for (const [route, d] of this.durations) {
      byRoute[route] = {
        count: d.count,
        avgMs: Number((d.totalMs / d.count).toFixed(1)),
        maxMs: d.maxMs,
      };
    }
    return {
      role: process.env.ROLE || 'api',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: Object.fromEntries(this.requests),
      latencyByRoute: byRoute,
      jobs: Object.fromEntries(this.jobs),
    };
  }
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** المسارات تحمل معاملات — الاقتباس المزدوج يكسر صيغة Prometheus */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
