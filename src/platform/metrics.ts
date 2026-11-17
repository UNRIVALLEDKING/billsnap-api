import { createMiddleware } from "hono/factory";

type Labels = Record<string, string>;
export type GaugeSample = { labels?: Labels; value: number };

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const esc = (v: string) =>
  v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
const fmtLabels = (l: Labels) => {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};

type Series = { labels: Labels; counts: number[]; sum: number; count: number };
type Gauge = { help: string; collect: () => GaugeSample[] | Promise<GaugeSample[]> };

export class Metrics {
  private readonly durations = new Map<string, Series>();
  private readonly gauges = new Map<string, Gauge>();

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    const key = `${method} ${route} ${status}`;
    let s = this.durations.get(key);
    if (!s) {
      s = { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.durations.set(key, s);
    }
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += seconds;
    s.count += 1;
  }

  /** Registers a gauge read at scrape time (e.g. queue depth). */
  gauge(name: string, help: string, collect: Gauge["collect"]): void {
    this.gauges.set(name, { help, collect });
  }

  async render(): Promise<string> {
    const out: string[] = [
      "# HELP http_request_duration_seconds HTTP request duration by route, method and status.",
      "# TYPE http_request_duration_seconds histogram",
    ];
    for (const s of this.durations.values()) {
      BUCKETS.forEach((le, i) => {
        out.push(
          `http_request_duration_seconds_bucket${fmtLabels({ ...s.labels, le: String(le) })} ${s.counts[i]}`,
        );
      });
      out.push(
        `http_request_duration_seconds_bucket${fmtLabels({ ...s.labels, le: "+Inf" })} ${s.count}`,
      );
      out.push(`http_request_duration_seconds_sum${fmtLabels(s.labels)} ${s.sum}`);
      out.push(`http_request_duration_seconds_count${fmtLabels(s.labels)} ${s.count}`);
    }
    for (const [name, g] of this.gauges) {
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      for (const sample of await g.collect()) {
        out.push(`${name}${fmtLabels(sample.labels ?? {})} ${sample.value}`);
      }
    }
    return `${out.join("\n")}\n`;
  }
}

/** Records duration per matched route pattern (never the raw path, to keep label cardinality bounded). */
export const httpMetrics = (metrics: Metrics) =>
  createMiddleware(async (c, next) => {
    const start = performance.now();
    await next();
    const route = c.req.routePath === "/*" ? "unmatched" : c.req.routePath;
    metrics.observeHttp(c.req.method, route, c.res.status, (performance.now() - start) / 1000);
  });

/** Queue depth gauge. Stub source until the job catalog exists; pass a real reader later. */
export function registerQueueGauge(
  metrics: Metrics,
  source: () => GaugeSample[] | Promise<GaugeSample[]> = () => [],
): void {
  metrics.gauge("queue_jobs", "Jobs per queue and state.", source);
}

/** Serves /metrics on its own port so it is never exposed through the public listener. */
export function startMetricsServer(metrics: Metrics, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/metrics") {
        return new Response(await metrics.render(), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}
