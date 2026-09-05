import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";

// Needs `docker compose up`. Run with `pnpm test:integration`.
// Proves every LGTM port the plan relies on is mapped, Loki's included, since the
// grafana/otel-lgtm image does not publish 3100 on its own.
describe("Grafana LGTM container", () => {
  const { infra } = loadConfig();

  const probes: Array<[name: string, url: string]> = [
    ["Grafana", `${infra.grafanaUrl}/api/health`],
    ["Loki", `${infra.lokiUrl}/ready`],
    ["Tempo", `${infra.tempoUrl}/ready`],
    ["Prometheus", `${infra.prometheusUrl}/-/ready`],
  ];

  it.each(probes)("%s answers its readiness endpoint", async (_name, url) => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });

  it("accepts OTLP traces over HTTP", async () => {
    const response = await fetch(`${infra.otlpEndpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
    });
    expect(response.status).toBe(200);
  });
});
