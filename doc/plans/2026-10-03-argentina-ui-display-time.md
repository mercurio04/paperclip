# Argentina UI display time

This instance renders human-facing instant timestamps in
`America/Argentina/Buenos_Aires`. The display does not depend on the browser or
host time zone. `ui/src/lib/display-time.ts` owns the presentation helpers.

- Chat, run/log clocks, detail rows, receipts and tooltips use that zone.
- Calendar grouping of timestamped task/learning entries uses the same day.
- Plain `YYYY-MM-DD` and calendar-only target/release dates retain their day.
- Elapsed durations do not change. Monitor controls convert Argentina wall time
  back to UTC only when the operator saves; their unchanged value round-trips. Decision snooze controls and the new
  Tomorrow preset use Argentina wall time. Existing deadlines are unchanged.
- Timeline, audit and decision filters use Argentina calendar boundaries.
  Cost ranges retain their browser calendar and explicitly name it.
- Explicit cron/active-hours zones, schedule calculations, authoritative UTC
  budget/day aggregates, payloads, HTML `dateTime`, source logs, raw JSON and
  copied/downloaded evidence retain their original semantics and values.
- Historical prose/quoted evidence is not rewritten. Agent report instructions
  are managed separately.

This is a static UI patch on the installed `2026.916.1` backport. It needs no
server restart, data migration, OS clock/time-zone change or permission change.
