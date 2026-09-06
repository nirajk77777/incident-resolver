import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

describe("loadConfig", () => {
  it("returns the documented defaults when the environment is empty", () => {
    const config = loadConfig({});

    expect(config.models).toEqual({
      resolver: "gpt-5.4",
      triage: "gpt-5.4-mini",
      investigator: "gpt-5.4-mini",
      codeRca: "gpt-5.4",
      fixShipper: "gpt-5.4-mini",
      sentinel: "gpt-5.4-nano",
      embeddings: "embed-v4.0",
      rerank: "rerank-v3.5",
    });
    expect(config.confidenceThreshold).toBe(0.6);
    expect(config.sentinel).toEqual({
      errorRatio: 0.2,
      windowSeconds: 60,
      minRequests: 5,
      pollIntervalMs: 10_000,
    });
    expect(config.runTimeoutMs).toBe(600_000);
    expect(config.dataFixRowCap).toBe(100);
    expect(config.queryRowCap).toBe(200);
    expect(config.logLineCap).toBe(100);
    expect(config.shopliteServiceName).toBe("shoplite-api");
    expect(config.infra).toEqual({
      databaseUrl: "postgres://postgres:postgres@localhost:5432/incident_resolver",
      shopliteReadonlyDatabaseUrl:
        "postgres://shoplite_reader:shoplite_reader@localhost:5432/incident_resolver",
      otlpEndpoint: "http://localhost:4318",
      lokiUrl: "http://localhost:3100",
      tempoUrl: "http://localhost:3200",
      prometheusUrl: "http://localhost:9090",
      grafanaUrl: "http://localhost:3000",
      langfuseBaseUrl: "https://cloud.langfuse.com",
    });
  });

  it("reads every value from the environment", () => {
    const config = loadConfig({
      MODEL_RESOLVER: "gpt-6",
      MODEL_TRIAGE: "a",
      MODEL_INVESTIGATOR: "b",
      MODEL_CODE_RCA: "c",
      MODEL_FIX_SHIPPER: "d",
      MODEL_SENTINEL: "e",
      MODEL_EMBEDDINGS: "f",
      MODEL_RERANK: "g",
      CONFIDENCE_THRESHOLD: "0.75",
      SENTINEL_ERROR_RATIO: "0.5",
      SENTINEL_WINDOW_SECONDS: "120",
      SENTINEL_MIN_REQUESTS: "10",
      SENTINEL_POLL_INTERVAL_MS: "5000",
      RUN_TIMEOUT_MS: "1000",
      DATA_FIX_ROW_CAP: "7",
      QUERY_ROW_CAP: "9",
      LOG_LINE_CAP: "11",
      SHOPLITE_SERVICE_NAME: "shop",
      DATABASE_URL: "postgres://u:p@db:5432/x",
      SHOPLITE_READONLY_DATABASE_URL: "postgres://r:p@db:5432/x",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://lgtm:4318",
      LOKI_URL: "http://lgtm:3100",
      TEMPO_URL: "http://lgtm:3200",
      PROMETHEUS_URL: "http://lgtm:9090",
      GRAFANA_URL: "http://lgtm:3000",
      LANGFUSE_BASE_URL: "http://langfuse:3001",
    });

    expect(config.models).toEqual({
      resolver: "gpt-6",
      triage: "a",
      investigator: "b",
      codeRca: "c",
      fixShipper: "d",
      sentinel: "e",
      embeddings: "f",
      rerank: "g",
    });
    expect(config.confidenceThreshold).toBe(0.75);
    expect(config.sentinel).toEqual({
      errorRatio: 0.5,
      windowSeconds: 120,
      minRequests: 10,
      pollIntervalMs: 5000,
    });
    expect(config.runTimeoutMs).toBe(1000);
    expect(config.dataFixRowCap).toBe(7);
    expect(config.queryRowCap).toBe(9);
    expect(config.logLineCap).toBe(11);
    expect(config.shopliteServiceName).toBe("shop");
    expect(config.infra).toEqual({
      databaseUrl: "postgres://u:p@db:5432/x",
      shopliteReadonlyDatabaseUrl: "postgres://r:p@db:5432/x",
      otlpEndpoint: "http://lgtm:4318",
      lokiUrl: "http://lgtm:3100",
      tempoUrl: "http://lgtm:3200",
      prometheusUrl: "http://lgtm:9090",
      grafanaUrl: "http://lgtm:3000",
      langfuseBaseUrl: "http://langfuse:3001",
    });
  });

  it("treats an empty string as unset so a blank .env line keeps the default", () => {
    const config = loadConfig({ CONFIDENCE_THRESHOLD: "", MODEL_RESOLVER: "" });

    expect(config.confidenceThreshold).toBe(0.6);
    expect(config.models.resolver).toBe("gpt-5.4");
  });

  it("rejects a non-numeric threshold and names the variable", () => {
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: "high" })).toThrow(ConfigError);
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: "high" })).toThrow(/CONFIDENCE_THRESHOLD/);
  });

  it("rejects a Confidence threshold outside 0..1", () => {
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: "1.5" })).toThrow(ConfigError);
  });

  it("rejects non-integer or non-positive counts and timeouts", () => {
    expect(() => loadConfig({ SENTINEL_MIN_REQUESTS: "2.5" })).toThrow(/SENTINEL_MIN_REQUESTS/);
    expect(() => loadConfig({ RUN_TIMEOUT_MS: "0" })).toThrow(/RUN_TIMEOUT_MS/);
    expect(() => loadConfig({ DATA_FIX_ROW_CAP: "-1" })).toThrow(/DATA_FIX_ROW_CAP/);
    expect(() => loadConfig({ QUERY_ROW_CAP: "0" })).toThrow(/QUERY_ROW_CAP/);
    expect(() => loadConfig({ LOG_LINE_CAP: "0" })).toThrow(/LOG_LINE_CAP/);
  });

  it("rejects a malformed OTLP endpoint", () => {
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
  });

  it("does not mutate the environment it was given", () => {
    const env = { CONFIDENCE_THRESHOLD: "0.9" };
    loadConfig(env);
    expect(env).toEqual({ CONFIDENCE_THRESHOLD: "0.9" });
  });
});
