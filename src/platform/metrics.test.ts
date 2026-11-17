import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { httpMetrics, Metrics, registerQueueGauge, startMetricsServer } from "./metrics";

describe("metrics", () => {
  test("histogram is recorded per route pattern, method and status", async () => {
    const metrics = new Metrics();
    const app = new Hono();
    app.use(httpMetrics(metrics));
    app.get("/things/:id", (c) => c.text("ok"));
    await app.request("/things/1");
    await app.request("/things/2");
    await app.request("/nope");
    const text = await metrics.render();
    expect(text).toContain("# TYPE http_request_duration_seconds histogram");
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/things/:id",status="200"} 2',
    );
    expect(text).toContain('route="unmatched",status="404"} 1');
    expect(text).toContain('le="+Inf"');
    expect(text).not.toContain("/things/1");
  });

  test("queue gauge is collected at scrape time", async () => {
    const metrics = new Metrics();
    registerQueueGauge(metrics, () => [
      { labels: { queue: "bill.extract", state: "created" }, value: 3 },
    ]);
    expect(await metrics.render()).toContain('queue_jobs{queue="bill.extract",state="created"} 3');
  });

  test("the metrics server serves /metrics and nothing else", async () => {
    const server = startMetricsServer(new Metrics(), 0);
    try {
      const ok = await fetch(`http://localhost:${server.port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/plain");
      expect((await fetch(`http://localhost:${server.port}/health`)).status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });
});
