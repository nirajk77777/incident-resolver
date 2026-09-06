import { z } from "zod";

/**
 * All tunables live here and are read from the environment with defaults,
 * so swapping a model or a threshold never touches agent code.
 * See PLAN.md section 12 and `.env.example`.
 */

const count = () => z.coerce.number().int().positive();
const ratio = () => z.coerce.number().min(0).max(1);

const configSchema = z
  .object({
    // Models. gpt-5.4 where the agent reasons and decides, gpt-5.4-mini where it
    // gathers evidence or follows a fixed procedure, gpt-5.4-nano where it only formats text.
    MODEL_RESOLVER: z.string().default("gpt-5.4"),
    MODEL_TRIAGE: z.string().default("gpt-5.4-mini"),
    MODEL_INVESTIGATOR: z.string().default("gpt-5.4-mini"),
    MODEL_CODE_RCA: z.string().default("gpt-5.4"),
    MODEL_FIX_SHIPPER: z.string().default("gpt-5.4-mini"),
    MODEL_SENTINEL: z.string().default("gpt-5.4-nano"),
    MODEL_EMBEDDINGS: z.string().default("embed-v4.0"),
    MODEL_RERANK: z.string().default("rerank-v3.5"),

    // Confidence below this escalates the Ticket.
    CONFIDENCE_THRESHOLD: ratio().default(0.6),

    // Sentinel fires when a route's error ratio exceeds ERROR_RATIO over WINDOW_SECONDS
    // with at least MIN_REQUESTS, polling Prometheus every POLL_INTERVAL_MS.
    SENTINEL_ERROR_RATIO: ratio().default(0.2),
    SENTINEL_WINDOW_SECONDS: count().default(60),
    SENTINEL_MIN_REQUESTS: count().default(5),
    SENTINEL_POLL_INTERVAL_MS: count().default(10_000),

    // A Resolver run that exceeds this closes the Ticket as escalated with reason agent_error.
    RUN_TIMEOUT_MS: count().default(600_000),

    // An approved data fix that would touch more rows than this is refused.
    DATA_FIX_ROW_CAP: count().default(100),

    // A read-only query through mcp-database returns at most this many rows.
    QUERY_ROW_CAP: count().default(200),

    // Infrastructure from docker-compose.yml.
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://postgres:postgres@localhost:5432/incident_resolver"),
    // The SELECT-only role mcp-database connects as, created by migration 0002.
    SHOPLITE_READONLY_DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://shoplite_reader:shoplite_reader@localhost:5432/incident_resolver"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default("http://localhost:4318"),
    LOKI_URL: z.url().default("http://localhost:3100"),
    TEMPO_URL: z.url().default("http://localhost:3200"),
    PROMETHEUS_URL: z.url().default("http://localhost:9090"),
    GRAFANA_URL: z.url().default("http://localhost:3000"),
  })
  .transform((env) => ({
    models: {
      resolver: env.MODEL_RESOLVER,
      triage: env.MODEL_TRIAGE,
      investigator: env.MODEL_INVESTIGATOR,
      codeRca: env.MODEL_CODE_RCA,
      fixShipper: env.MODEL_FIX_SHIPPER,
      sentinel: env.MODEL_SENTINEL,
      embeddings: env.MODEL_EMBEDDINGS,
      rerank: env.MODEL_RERANK,
    },
    confidenceThreshold: env.CONFIDENCE_THRESHOLD,
    sentinel: {
      errorRatio: env.SENTINEL_ERROR_RATIO,
      windowSeconds: env.SENTINEL_WINDOW_SECONDS,
      minRequests: env.SENTINEL_MIN_REQUESTS,
      pollIntervalMs: env.SENTINEL_POLL_INTERVAL_MS,
    },
    runTimeoutMs: env.RUN_TIMEOUT_MS,
    dataFixRowCap: env.DATA_FIX_ROW_CAP,
    queryRowCap: env.QUERY_ROW_CAP,
    infra: {
      databaseUrl: env.DATABASE_URL,
      shopliteReadonlyDatabaseUrl: env.SHOPLITE_READONLY_DATABASE_URL,
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      lokiUrl: env.LOKI_URL,
      tempoUrl: env.TEMPO_URL,
      prometheusUrl: env.PROMETHEUS_URL,
      grafanaUrl: env.GRAFANA_URL,
    },
  }));

export type Config = z.output<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

/** Drops empty strings so a blank line in .env falls back to the default. */
function withoutBlanks(env: Env): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") cleaned[key] = value;
  }
  return cleaned;
}

export function loadConfig(env: Env = process.env): Config {
  const parsed = configSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Process-wide config, read from `process.env` once on first use. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
