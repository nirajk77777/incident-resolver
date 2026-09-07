import { describe, expect, it } from "vitest";
import { joinUrl } from "./url";

describe("joinUrl", () => {
  it("keeps the path the base carries, which new URL() would drop", () => {
    expect(joinUrl("http://portal:5000/api", "/tickets")).toBe("http://portal:5000/api/tickets");
    expect(new URL("/tickets", "http://portal:5000/api").href).toBe("http://portal:5000/tickets");
  });

  it("is indifferent to slashes on either side of the join", () => {
    expect(joinUrl("http://portal:5000/api/", "/tickets")).toBe("http://portal:5000/api/tickets");
    expect(joinUrl("http://portal:5000/api", "tickets")).toBe("http://portal:5000/api/tickets");
    expect(joinUrl("http://portal:5000", "/tickets")).toBe("http://portal:5000/tickets");
  });
});
