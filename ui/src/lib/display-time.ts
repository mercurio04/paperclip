/** Instance UI presentation only. Stored instants and schedule zones stay unchanged. */
export const DISPLAY_TIME_ZONE = "America/Argentina/Buenos_Aires";
export const DISPLAY_TIME_ZONE_LABEL = "Argentina · ART (UTC−03:00)";
export type DisplayDate = Date | string | number;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateForDisplay(value: DisplayDate): { date: Date; timeZone: string } {
  // A calendar date is not an instant. Do not move a deadline/release to yesterday.
  if (typeof value === "string" && CALENDAR_DATE.test(value)) {
    return { date: new Date(`${value}T00:00:00Z`), timeZone: "UTC" };
  }
  return { date: new Date(value), timeZone: DISPLAY_TIME_ZONE };
}

export function displayDateTimeFormatter(
  locales?: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locales, { ...options, timeZone: options.timeZone ?? DISPLAY_TIME_ZONE });
}

export function displayDateString(
  value: DisplayDate,
  locales?: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const { date, timeZone } = dateForDisplay(value);
  return date.toLocaleDateString(locales, { ...options, timeZone });
}

export function displayDateTimeString(
  value: DisplayDate,
  locales?: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const { date, timeZone } = dateForDisplay(value);
  return date.toLocaleString(locales, { ...options, timeZone });
}

export function displayTimeString(
  value: DisplayDate,
  locales?: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const { date, timeZone } = dateForDisplay(value);
  return date.toLocaleTimeString(locales, { ...options, timeZone });
}

/** Stable calendar key in the display zone, independent of browser locale/TZ. */
export function displayDayKey(value: DisplayDate): string {
  if (typeof value === "string" && CALENDAR_DATE.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const parts = displayDateTimeFormatter("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function displayCalendarOrdinal(value: DisplayDate): number {
  return Date.parse(`${displayDayKey(value)}T00:00:00Z`);
}

/** A wall-clock value for datetime-local controls; never store this string as an instant. */
export function displayDateTimeLocalValue(value: DisplayDate): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = displayDateTimeFormatter("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Convert explicit Argentina wall time back to the same UTC instant on user save. */
export function parseDisplayDateTimeLocal(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return new Date(NaN);
  const wallTime = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wallTime)) return new Date(NaN);
  let candidate = wallTime;
  for (let i = 0; i < 3; i++) {
    const shown = Date.parse(`${displayDateTimeLocalValue(candidate)}:00Z`);
    const adjustment = wallTime - shown;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  return displayDateTimeLocalValue(candidate) === value ? new Date(candidate) : new Date(NaN);
}

export function displayDayStart(value: DisplayDate): Date {
  return parseDisplayDateTimeLocal(`${displayDayKey(value)}T00:00`);
}

/** Calendar-only fields can arrive as midnight ISO dates from the API. */
export function displayCalendarDate(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export function displayDayEnd(value: DisplayDate): Date {
  if (!Number.isFinite(displayDayStart(value).getTime())) return new Date(NaN);
  const nextDay = new Date(displayCalendarOrdinal(value) + 86_400_000).toISOString().slice(0, 10);
  return new Date(displayDayStart(nextDay).getTime() - 1);
}

/** UI snooze preset; existing stored deadlines and elapsed-duration presets stay intact. */
export function displayTomorrowMorning(value: DisplayDate = new Date()): Date {
  const day = new Date(displayCalendarOrdinal(value) + 86_400_000).toISOString().slice(0, 10);
  return parseDisplayDateTimeLocal(`${day}T09:00`);
}
