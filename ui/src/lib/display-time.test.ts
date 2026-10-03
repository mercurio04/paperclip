import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPLAY_TIME_ZONE, displayDateString, displayDateTimeString, displayTimeString,
  displayDateTimeFormatter, displayDayKey, displayCalendarOrdinal,
  displayDateTimeLocalValue, parseDisplayDateTimeLocal, displayDayStart, displayCalendarDate, displayTomorrowMorning,
} from "./display-time";
import { formatDate, formatDateTime, relativeTime, formatCents } from "./utils";
import { taskDateGroup } from "./task-date-groups";
import { formatMonitorAbsolute, formatMonitorEta } from "./issue-monitor";
import { learningDayKey, learningDayLabel } from "./pipeline-learnings";
import { formatTaskChatTimestamp } from "../components/task-chat/task-chat-adapter";
import { attentionDateBucket, resolveAttentionDateRange } from "./attention";
import { formatReleaseDate } from "../pages/agent-skills/AgentSkillReleasePicker";

afterEach(() => vi.useRealTimers());
const instant = "2026-10-03T01:30:45.000Z";

describe("Argentina display time independent of the browser zone", () => {
  it.each([instant, "2026-10-03T03:30:45+02:00", "2026-10-02T22:30:45-03:00", new Date(instant), Date.parse(instant)])(
    "renders equal instants with the Argentina date and precise clock: %s", (value) => {
      expect(displayDayKey(value)).toBe("2026-10-02");
      expect(displayTimeString(value, "en-GB", { hourCycle: "h23" })).toBe("22:30:45");
      expect(displayDateString(value, "en-GB")).toBe("02/10/2026");
    },
  );
  it("uses the local midnight boundary, including a year change", () => {
    expect(displayDayKey("2026-10-03T02:59:59Z")).toBe("2026-10-02");
    expect(displayDayKey("2026-10-03T03:00:00Z")).toBe("2026-10-03");
    expect(displayDayKey("2027-01-01T01:00:00Z")).toBe("2026-12-31");
    expect(displayCalendarOrdinal(instant)).toBe(Date.UTC(2026, 9, 2));
  });
  it("keeps plain calendar dates and calendar-only API fields on their stated day", () => {
    expect(displayDayKey("2026-10-03")).toBe("2026-10-03");
    expect(formatDate("2026-10-03")).toBe("Oct 3, 2026");
    expect(formatDate(displayCalendarDate("2026-10-03T00:00:00Z"))).toBe("Oct 3, 2026");
    expect(formatReleaseDate("2026-10-03")).toBe("2026-10-03");
    expect(formatReleaseDate(instant)).toBe("2026-10-02");
  });
  it("formats logs with seconds and reports with an explicit offset without altering evidence", () => {
    const date = new Date(instant);
    expect(formatDateTime(date, { includeSeconds: true })).toContain("10:30:45 PM GMT-3");
    expect(formatDateTime(date)).toContain("10:30 PM GMT-3");
    expect(displayDateTimeString(date, "en-GB")).toContain("22:30:45");
    expect(date.toISOString()).toBe(instant);
    expect(JSON.stringify({ ts: instant, date })).toBe('{"ts":"2026-10-03T01:30:45.000Z","date":"2026-10-03T01:30:45.000Z"}');
  });
  it("uses the same clock for chat footers and display-zone calendar groups", () => {
    expect(formatTaskChatTimestamp(instant)).toContain("10:30");
    const now = new Date("2026-10-03T02:00:00Z");
    expect(taskDateGroup(instant, now)).toBe("today");
    expect(taskDateGroup("2026-10-02T02:00:00Z", now)).toBe("yesterday");
    expect(taskDateGroup("2026-09-30T03:00:00Z", now)).toBe("earlier");
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(learningDayKey(instant)).toBe("2026-10-02");
    expect(learningDayLabel(instant)).toBe("Today");
    expect(learningDayLabel("2026-10-02T02:00:00Z")).toBe("Yesterday");
  });
  it("keeps relative durations intact and changes Today at the Argentina midnight", () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-10-03T02:59:00Z");
    expect(relativeTime("2026-10-03T02:54:00Z")).toBe("5m ago");
    expect(formatMonitorEta("2026-10-03T03:01:00Z")).toBe("in 2m");
    expect(formatMonitorAbsolute("2026-10-03T03:01:00Z", { locale: "en-US" })).not.toContain("Today");
    expect(formatMonitorAbsolute("2026-10-03T02:59:00Z", { locale: "en-US" })).toContain("Today, 11:59 PM");
  });
  it("does not drop minutes when a browser has a fractional timezone offset", () => {
    const at = new Date("2026-10-03T00:15:00Z");
    expect(Number(displayDateTimeFormatter("en-US", { minute: "numeric" }).format(at))).toBe(15);
    expect(displayTimeString(at, "en-US", { hour: "numeric", minute: "2-digit" })).toBe("9:15 PM");
  });
  it("preserves explicitly configured schedule formatter zones", () => {
    expect(displayDateTimeFormatter("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(instant))).toBe("01:30");
    expect([DISPLAY_TIME_ZONE, "America/Buenos_Aires"]).toContain(displayDateTimeFormatter().resolvedOptions().timeZone);
  });
  it("keeps decision date groups and UI date filters on the Argentina day", () => {
    const now = Date.parse("2026-10-03T02:59:00Z");
    expect(attentionDateBucket("2026-10-02T01:30:00Z", now)).toBe("yesterday");
    expect(attentionDateBucket("2026-10-03T01:30:00Z", now)).toBe("today");
    expect(resolveAttentionDateRange("custom", now, { from: "invalid", to: "invalid" })).toEqual({});
    expect(resolveAttentionDateRange("today", now)).toEqual({ activitySince: "2026-10-02T03:00:00.000Z" });
    expect(resolveAttentionDateRange("yesterday", now)).toEqual({ activitySince: "2026-10-01T03:00:00.000Z", activityUntil: "2026-10-02T02:59:59.999Z" });
    expect(resolveAttentionDateRange("custom", now, { from: "2026-10-03", to: "2026-10-03" })).toEqual({ activitySince: "2026-10-03T03:00:00.000Z", activityUntil: "2026-10-04T02:59:59.999Z" });
  });
  it("keeps number formatting separate", () => expect(formatCents(123456)).toBe("$1,234.56"));
  it("does not invent dates for invalid optional metadata", () => {
    expect(displayDateString("invalid")).toBe("Invalid Date");
    expect(displayDayKey("invalid")).toBe("Invalid Date");
    expect(displayDateTimeLocalValue("invalid")).toBe("");
    expect(formatTaskChatTimestamp("invalid")).toBeUndefined();
    expect(formatTaskChatTimestamp(null)).toBeUndefined();
  });
});

describe("Argentina datetime-local controls preserve the selected instant", () => {
  it.each(["2026-10-03T01:30:00.000Z", "2026-10-03T03:00:00.000Z", "2027-01-01T01:00:00.000Z"])("round-trips %s", (iso) => {
    const local = displayDateTimeLocalValue(iso);
    expect(parseDisplayDateTimeLocal(local).toISOString()).toBe(iso);
  });
  it("resolves new snooze wall times and tomorrow at nine in Argentina", () => {
    expect(parseDisplayDateTimeLocal("2026-10-03T09:00").toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(displayTomorrowMorning("2026-10-03T01:30:00Z").toISOString()).toBe("2026-10-03T12:00:00.000Z");
  });
  it("shows the previous day in a control and computes its Argentina day start", () => {
    expect(displayDateTimeLocalValue(instant)).toBe("2026-10-02T22:30");
    expect(displayDayStart(instant).toISOString()).toBe("2026-10-02T03:00:00.000Z");
  });
  it.each(["", "garbage", "2026-02-30T01:30", "2026-10-03T25:00", "2026-10-03T01:30Z", "2008-10-19T00:30"])("rejects invalid/unqualified control input %s", (value) => {
    expect(Number.isNaN(parseDisplayDateTimeLocal(value).getTime())).toBe(true);
  });
});
