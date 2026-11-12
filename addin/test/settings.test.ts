import { describe, expect, it } from "vitest";
import { parseRecentNames, withRecentName } from "../src/shared/settings";

describe("recent signature names", () => {
  it("parses safely", () => {
    expect(parseRecentNames(undefined)).toEqual([]);
    expect(parseRecentNames("not json")).toEqual([]);
    expect(parseRecentNames('["Tim", 3, "Regards"]')).toEqual(["Tim", "Regards"]);
  });

  it("puts the newest first, de-duplicates case-insensitively, caps at 10", () => {
    expect(withRecentName(["Regards", "Tim"], "tim")).toEqual(["tim", "Regards"]);
    expect(withRecentName(["A"], "  ")).toEqual(["A"]);
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    expect(withRecentName(many, "new")).toHaveLength(10);
  });
});
