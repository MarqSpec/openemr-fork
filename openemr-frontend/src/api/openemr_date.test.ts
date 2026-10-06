import {describe, expect, it} from 'vitest';

import {
  calendarDate,
  hasNotEnded,
  isAfterWallClock,
  localCalendarDate,
  localWallClock,
  wallClock,
  wallClockDate,
} from './openemr_date';

// OpenEMR stamps its server's wall-clock time with the server's current offset (UtilsService::getLocalDateAsUTC),
// so the offset says nothing about the instant. Each case pairs +14:00 with -12:00: a helper that converts
// through the device's time zone gets at least one of them wrong on any runner.
// reference: REQUIREMENTS.md BUG-51

describe('given an OpenEMR date or dateTime, when its calendar date is shown', () => {
  it('then midnight at +14:00 is that same day, not the day before', () => {
    expect(wallClockDate('2026-09-25T00:00:00+14:00')).toBe('2026-09-25');
  });

  it('then late evening at -12:00 is that same day, not the day after', () => {
    expect(wallClockDate('2026-09-25T23:30:00-12:00')).toBe('2026-09-25');
  });

  it('then UTC and fractional seconds change nothing', () => {
    expect(wallClockDate('2026-09-25T00:00:00Z')).toBe('2026-09-25');
    expect(wallClockDate('2026-09-25T00:00:00.000-04:00')).toBe('2026-09-25');
  });

  it('then a date-only value is shown as sent, partial dates included', () => {
    expect(wallClockDate('1970-06-15')).toBe('1970-06-15');
    expect(wallClockDate('1970-06')).toBe('1970-06');
    expect(wallClockDate('1970')).toBe('1970');
  });

  it('then a MySQL-style value from the REST API gives its date', () => {
    expect(wallClockDate('2026-09-25 00:00:00')).toBe('2026-09-25');
  });

  it('then an absent or blank value is not recorded', () => {
    expect(wallClockDate(undefined)).toBeUndefined();
    expect(wallClockDate('  ')).toBeUndefined();
  });

  it('then a malformed value is shown as sent rather than dropped or guessed at', () => {
    expect(wallClockDate('25/09/2026')).toBe('25/09/2026');
    expect(wallClockDate('2026-9-5')).toBe('2026-9-5');
  });
});

describe('given an OpenEMR date or dateTime, when a whole calendar date is required', () => {
  it('then midnight at +14:00 and late evening at -12:00 are the days recorded', () => {
    expect(calendarDate('2026-01-10T00:00:00+14:00')).toBe('2026-01-10');
    expect(calendarDate('2026-01-10T23:30:00-12:00')).toBe('2026-01-10');
    expect(calendarDate('2026-01-10')).toBe('2026-01-10');
  });

  it('then a partial date, a day that does not exist, or a malformed value has none', () => {
    expect(calendarDate('2026-01')).toBeUndefined();
    expect(calendarDate('2026-02-31T00:00:00-05:00')).toBeUndefined();
    expect(calendarDate('2026-13-01')).toBeUndefined();
    expect(calendarDate('25/09/2026')).toBeUndefined();
    expect(calendarDate(undefined)).toBeUndefined();
  });

  it('then 29 February exists only in a leap year', () => {
    expect(calendarDate('2024-02-29')).toBe('2024-02-29');
    expect(calendarDate('2025-02-29')).toBeUndefined();
  });
});

describe('given an OpenEMR dateTime, when it is read as wall-clock time', () => {
  it('then the offset is dropped, never applied', () => {
    expect(wallClock('2026-09-26T00:00:00+14:00')).toBe('2026-09-26T00:00:00');
    expect(wallClock('2026-09-25T00:00:00-12:00')).toBe('2026-09-25T00:00:00');
  });

  it('then a date-only or partial value is its first moment', () => {
    expect(wallClock('2026-09-25')).toBe('2026-09-25T00:00:00');
    expect(wallClock('2026-09')).toBe('2026-09-01T00:00:00');
    expect(wallClock('2026')).toBe('2026-01-01T00:00:00');
  });

  it('then a MySQL-style value and one without seconds read the same way', () => {
    expect(wallClock('2026-09-25 13:45:10')).toBe('2026-09-25T13:45:10');
    expect(wallClock('2026-09-25T13:45-04:00')).toBe('2026-09-25T13:45:00');
  });

  it('then an absent or malformed value has no wall-clock time', () => {
    expect(wallClock(undefined)).toBeUndefined();
    expect(wallClock('')).toBeUndefined();
    expect(wallClock('25/09/2026')).toBeUndefined();
    expect(wallClock('2026-09-25T00:00:00 garbage')).toBeUndefined();
  });

  it('then values sort by what the clinic recorded, whatever offsets they carry', () => {
    const recorded = [
      '2026-09-25T09:00:00-12:00',
      '2026-09-25',
      '2026-09-25T08:00:00+14:00',
    ];
    expect(recorded.map(wallClock).sort()).toEqual([
      '2026-09-25T00:00:00',
      '2026-09-25T08:00:00',
      '2026-09-25T09:00:00',
    ]);
  });
});

describe('given the device clock', () => {
  it('when it is read as a calendar date, then it is the local date, zero-padded', () => {
    expect(localCalendarDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('when it is read as wall-clock time, then it is the local time in the same shape as OpenEMR values', () => {
    expect(localWallClock(new Date(2026, 0, 5, 7, 8, 9))).toBe(
      '2026-01-05T07:08:09',
    );
  });
});

describe('given an end date and "now", when asking whether the end is still to come (legacy filterActiveIssues)', () => {
  const now = new Date(2026, 8, 25, 15, 0);

  it('then tomorrow at midnight is still to come, even stamped +14:00', () => {
    expect(isAfterWallClock('2026-09-26T00:00:00+14:00', now)).toBe(true);
  });

  it('then today at midnight has passed, even stamped -12:00', () => {
    expect(isAfterWallClock('2026-09-25T00:00:00-12:00', now)).toBe(false);
  });

  it('then a date-only end date is its midnight', () => {
    expect(isAfterWallClock('2026-09-26', now)).toBe(true);
    expect(isAfterWallClock('2026-09-25', now)).toBe(false);
  });

  it('then later the same day is still to come', () => {
    expect(isAfterWallClock('2026-09-25T15:00:01-12:00', now)).toBe(true);
  });

  it('then a malformed end date cannot be judged, so the caller decides', () => {
    expect(isAfterWallClock('not a date', now)).toBeUndefined();
  });
});

// The shared end-date rule later cards use: absent or still to come is open, and an end date that cannot be read
// errs toward showing. review
describe('given an end date and "now", when asking whether the item is still open (review)', () => {
  const now = new Date(2026, 8, 25, 15, 0);

  it('then an item with no end date is open', () => {
    expect(hasNotEnded(undefined, now)).toBe(true);
  });

  it('then an end date still to come is open and one that has passed is not, read as wall-clock (BUG-51)', () => {
    expect(hasNotEnded('2026-09-26T00:00:00+14:00', now)).toBe(true);
    expect(hasNotEnded('2026-09-25T00:00:00-12:00', now)).toBe(false);
  });

  it.each(['not a date', '', '   ', '2026-09-25 at noon', '25/09/2026'])(
    'then an end date that cannot be read (%j) errs toward showing: the item is open',
    value => {
      expect(hasNotEnded(value, now)).toBe(true);
    },
  );
});
