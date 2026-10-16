// Time and number formatting for the interface: relative in the text, absolute UTC in a title.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "14 min ago", "3 hours ago", "in about 46 min". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const abs = Math.abs(diff);
  if (abs < 10 * SECOND) return diff < 0 ? "in a moment" : "just now";
  const text =
    abs < MINUTE
      ? `${Math.round(abs / SECOND)} s`
      : abs < HOUR
        ? `${Math.round(abs / MINUTE)} min`
        : abs < DAY
          ? plural(Math.round(abs / HOUR), "hour")
          : plural(Math.round(abs / DAY), "day");
  return diff < 0 ? `in about ${text}` : `${text} ago`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "2026-10-16 14:32 UTC", for title attributes next to a relative time. */
export function absoluteUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** "12 Apr 2018", in UTC. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The same instant some days later, as ISO. */
export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY).toISOString();
}

/** "12,340". */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Whole seconds since the time, never negative; for "Updated 3 s ago" tickers. */
export function secondsSince(epochMs: number, now = Date.now()): number {
  return Math.max(0, Math.round((now - epochMs) / SECOND));
}
