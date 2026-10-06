// OpenEMR's dates are wall-clock readings, not instants: UtilsService::getLocalDateAsUTC stamps the server's
// local time with the server's *current* offset, so converting one through the device's time zone can move it to
// another calendar day. Read them as written — never through `Date`.
// reference: REQUIREMENTS.md BUG-51

/** A FHIR date (possibly partial) at the start of the value, alone or before a time. */
const LEADING_DATE = /^(\d{4}(?:-\d{2}(?:-\d{2})?)?)(?=$|[T ])/;

/** FHIR date / dateTime, or OpenEMR REST's MySQL `YYYY-MM-DD HH:MM:SS`; fraction and offset are read past. */
const WALL_CLOCK =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * The calendar date OpenEMR recorded, as written: `YYYY-MM-DD` (or the partial `YYYY` / `YYYY-MM` it sent).
 * `undefined` when absent or blank; a value that is not a date is returned as sent, so a card shows it rather
 * than dropping it or guessing.
 */
export function wallClockDate(value: string | undefined): string | undefined {
  const text = value?.trim() ?? '';
  if (text === '') return undefined;
  return LEADING_DATE.exec(text)?.[1] ?? text;
}

/**
 * The whole calendar date OpenEMR recorded, `YYYY-MM-DD`, or `undefined` when the value is absent, partial,
 * malformed or names a day that does not exist — for a card that must not show a guessed date.
 */
export function calendarDate(value: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/.exec(value?.trim() ?? '');
  if (match === null) return undefined;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  // Calendar arithmetic only, in UTC so no zone applies: does this day exist?
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
    ? match[0]
    : undefined;
}

/**
 * The wall-clock time OpenEMR recorded, as a sortable `YYYY-MM-DDTHH:MM:SS` with the offset dropped. A date-only
 * or partial value is its first moment. `undefined` when absent or unreadable.
 */
export function wallClock(value: string | undefined): string | undefined {
  const match = WALL_CLOCK.exec(value?.trim() ?? '');
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return `${year ?? ''}-${month ?? '01'}-${day ?? '01'}T${hour ?? '00'}:${minute ?? '00'}:${second ?? '00'}`;
}

/** The device clock's local calendar date, `YYYY-MM-DD`. */
export function localCalendarDate(now: Date): string {
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The device clock's local time in {@link wallClock}'s shape, so the two compare as strings. */
export function localWallClock(now: Date): string {
  return `${localCalendarDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Whether `value` is later than `now`, both read as wall-clock time — legacy's `strtotime(enddate) >
 * strtotime('now')`, assuming the tablet keeps the clinic's time zone. `undefined` when `value` is unreadable.
 */
export function isAfterWallClock(
  value: string | undefined,
  now: Date,
): boolean | undefined {
  const recorded = wallClock(value);
  return recorded === undefined ? undefined : recorded > localWallClock(now);
}

/**
 * Whether an item with end date `end` is still open at `now`: no end date, or one still to come, read as wall-clock
 * time ({@link isAfterWallClock}). An end date that cannot be read errs toward showing — never hide an item on a
 * guess.
 */
export function hasNotEnded(end: string | undefined, now: Date): boolean {
  return end === undefined || (isAfterWallClock(end, now) ?? true);
}
