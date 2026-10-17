// Time and number formatting: relative in the text, absolute UTC in a title, long dates past a week.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "14 min ago", "3 hours ago", "yesterday", "4 days ago", then the long date; "in about 46 min" ahead. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  const abs = Math.abs(diff);
  if (abs < 10 * SECOND) return diff < 0 ? "in a moment" : "just now";
  if (diff > 0 && abs >= DAY) {
    const days = Math.floor(abs / DAY);
    if (days < 2) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return longDate(iso);
  }
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

/** "April 12th 2018", in UTC. */
export function longDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const month = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} ${ordinal(d.getUTCDate())} ${d.getUTCFullYear()}`;
}

function ordinal(n: number): string {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** Server sentences carry ISO timestamps; show them as "2026-10-17 00:00 UTC" instead. */
export function humanizeTimes(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, (iso) => absoluteUtc(iso));
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
