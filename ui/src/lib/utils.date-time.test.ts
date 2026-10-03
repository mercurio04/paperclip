import { describe, expect, it } from "vitest";
import { formatDateTime } from "./utils";

describe("formatDateTime", () => {
  // An explicit offset keeps this fixture on the instance display clock.
  const timestamp = new Date("2026-09-07T13:02:54-03:00");

  it("preserves minute precision for existing callers", () => {
    expect(formatDateTime(timestamp)).toBe("Sep 7, 2026, 1:02 PM GMT-3");
  });

  it("distinguishes activity in the same minute when seconds are requested", () => {
    expect(formatDateTime(timestamp, { includeSeconds: true })).toBe(
      "Sep 7, 2026, 1:02:54 PM GMT-3",
    );
    expect(
      formatDateTime(new Date("2026-09-07T13:02:55-03:00"), { includeSeconds: true }),
    ).toBe("Sep 7, 2026, 1:02:55 PM GMT-3");
  });

  it("formats serialized server timestamps identically to Date values", () => {
    expect(
      formatDateTime(timestamp.toISOString(), { includeSeconds: true }),
    ).toBe(formatDateTime(timestamp, { includeSeconds: true }));
  });
});
