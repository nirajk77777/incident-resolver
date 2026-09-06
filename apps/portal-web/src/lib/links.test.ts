import { describe, expect, it } from "vitest";
import { grafanaTraceUrl, langfuseTraceUrl, TEMPO_DATASOURCE_UID } from "./links";

const traceId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

describe("langfuseTraceUrl", () => {
  it("points at the run, letting Langfuse resolve the project", () => {
    expect(langfuseTraceUrl("https://cloud.langfuse.com", traceId)).toBe(
      `https://cloud.langfuse.com/trace/${traceId}`,
    );
  });

  it("does not double the slash on a base URL that ends in one", () => {
    expect(langfuseTraceUrl("http://localhost:3001/", traceId)).toBe(
      `http://localhost:3001/trace/${traceId}`,
    );
  });
});

describe("grafanaTraceUrl", () => {
  it("opens Explore on the Tempo datasource with the trace id as the TraceQL query", () => {
    const url = new URL(grafanaTraceUrl("http://localhost:3000", traceId));

    expect(url.origin + url.pathname).toBe("http://localhost:3000/explore");
    const panes = JSON.parse(url.searchParams.get("panes") ?? "{}") as Record<
      string,
      { datasource: string; queries: Array<{ query: string; queryType: string }> }
    >;
    const pane = Object.values(panes)[0];
    expect(pane?.datasource).toBe(TEMPO_DATASOURCE_UID);
    expect(pane?.queries[0]).toMatchObject({ query: traceId, queryType: "traceql" });
  });
});
