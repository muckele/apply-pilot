// Weekly buckets for the owner's measurement page (MVP Bible WP1.9). Weeks run Monday 00:00 to
// the next Monday 00:00 in one fixed time zone, so a week holding a clock change is 167 or 169
// hours long. There is no per-user time zone in the schema yet; the owner's zone is the default.

export const METRICS_TIME_ZONE = "America/Los_Angeles";
export const MAX_METRIC_WEEKS = 53;

export type MetricWeek = {
  start: Date;
  end: Date;
  /** Local calendar date of the week's Monday, YYYY-MM-DD. */
  label: string;
  isCurrent: boolean;
};

type LocalDate = { year: number; month: number; day: number };

const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    formatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

// Milliseconds the zone is ahead of UTC at this instant (negative west of Greenwich).
function zoneOffsetMs(instant: Date, timeZone: string) {
  const local = localParts(instant, timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return localAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function localMidnight(date: LocalDate, timeZone: string) {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * dayMs);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function mondayOf(instant: Date, timeZone: string): LocalDate {
  const local = localParts(instant, timeZone);
  const date = { year: local.year, month: local.month, day: local.day };
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return addLocalDays(date, -((weekday + 6) % 7));
}

function formatLocalDate(date: LocalDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function startOfMetricWeek(instant: Date, timeZone = METRICS_TIME_ZONE) {
  return localMidnight(mondayOf(instant, timeZone), timeZone);
}

/** The `count` weeks ending with the week that holds `now`, oldest first. */
export function buildMetricWeeks(input: { now: Date; count: number; timeZone?: string }): MetricWeek[] {
  const { now, count } = input;
  const timeZone = input.timeZone ?? METRICS_TIME_ZONE;
  if (!Number.isInteger(count) || count < 1 || count > MAX_METRIC_WEEKS) {
    throw new RangeError(`Week count must be a whole number from 1 to ${MAX_METRIC_WEEKS}.`);
  }
  const currentMonday = mondayOf(now, timeZone);
  return Array.from({ length: count }, (_, index) => {
    const monday = addLocalDays(currentMonday, (index - count + 1) * 7);
    return {
      start: localMidnight(monday, timeZone),
      end: localMidnight(addLocalDays(monday, 7), timeZone),
      label: formatLocalDate(monday),
      isCurrent: index === count - 1
    };
  });
}
