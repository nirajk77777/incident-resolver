import { describe, expect, it } from "vitest";
import { escapeLabelValue, quoted } from "./escape";

describe("label values", () => {
  it("escapes backslashes and quotes", () => {
    expect(escapeLabelValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("wraps the escaped value in double quotes", () => {
    expect(quoted('x"y')).toBe('"x\\"y"');
  });
});
