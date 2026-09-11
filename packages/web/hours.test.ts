import { test, expect, describe } from 'bun:test';
import { type DayHours } from '@truescore/gmaps-shared';
import { formatHourLabel, isOpenNow, localHourInTz } from './hours';

describe('formatHourLabel', () => {
  test('midnight and noon edges', () => {
    expect(formatHourLabel(0)).toBe('12 AM');
    expect(formatHourLabel(24)).toBe('12 AM');
    expect(formatHourLabel(12)).toBe('12 PM');
  });
  test('morning and afternoon', () => {
    expect(formatHourLabel(9)).toBe('9 AM');
    expect(formatHourLabel(13)).toBe('1 PM');
    expect(formatHourLabel(23)).toBe('11 PM');
  });
  test('minutes', () => {
    expect(formatHourLabel(9.5)).toBe('9:30 AM');
    expect(formatHourLabel(14.25)).toBe('2:15 PM');
    expect(formatHourLabel(0.75)).toBe('12:45 AM');
  });
});

describe('isOpenNow', () => {
  const day = (openHour?: number, closeHour?: number, label?: string): DayHours =>
    ({ day: 'Monday', openHour, closeHour, label }) as DayHours;
  const slots = (...s: Array<[number, number]>): DayHours => ({ day: 'Monday', label: '', slots: s });
  const closed: DayHours = { day: 'Sunday', label: 'Closed' };

  test('normal daytime hours (close is exclusive)', () => {
    expect(isOpenNow(day(9, 17), 12)).toBe(true);
    expect(isOpenNow(day(9, 17), 8)).toBe(false);
    expect(isOpenNow(day(9, 17), 17)).toBe(false);
  });

  test('closing after midnight wraps correctly', () => {
    const bar = day(18, 2); // 6pm–2am
    expect(isOpenNow(bar, 23)).toBe(true); // 11pm
    expect(isOpenNow(bar, 1, bar)).toBe(true); // 1am, past midnight — the previous night's shift
    expect(isOpenNow(bar, 3, bar)).toBe(false); // 3am, after close
    expect(isOpenNow(bar, 15, bar)).toBe(false); // 3pm, before open
  });

  test("after midnight is judged by yesterday's hours, not today's", () => {
    // Sun 01:00 after a Sat 18–02: open, though Sunday itself is closed.
    expect(isOpenNow(closed, 1, day(18, 2))).toBe(true);
    // Tue 01:00 with Mon 09–17 / Tue 18–02: closed — Tuesday's shift starts at 18.
    expect(isOpenNow(day(18, 2), 1, day(9, 17))).toBe(false);
    // Mon 01:00 with Sun 18–02 / Mon 09–17: open on Sunday's shift.
    expect(isOpenNow(day(9, 17), 1, day(18, 2))).toBe(true);
  });

  test('every slot counts, minutes included', () => {
    const splitDay = slots([11.5, 14.5], [17, 22]); // 11:30–2:30, 5–10
    expect(isOpenNow(splitDay, 12)).toBe(true);
    expect(isOpenNow(splitDay, 14.75)).toBe(false);
    expect(isOpenNow(splitDay, 18)).toBe(true);
    expect(isOpenNow(slots([9.5, 17.5]), 17.25)).toBe(true);
  });

  test('explicit Closed vs unknown vs missing', () => {
    expect(isOpenNow(day(undefined, undefined, 'Closed'), 12)).toBe(false);
    expect(isOpenNow(day(undefined, undefined, 'Open 24 hours'), 12)).toBeNull();
    expect(isOpenNow(undefined, 12)).toBeNull();
  });
});

describe('localHourInTz', () => {
  const instant = new Date('2026-07-15T12:00:00Z'); // noon UTC

  test('resolves the wall-clock hour in a given timezone', () => {
    expect(localHourInTz('America/New_York', instant).hour).toBe(8); // UTC-4 in July
    expect(localHourInTz('Asia/Tokyo', instant).hour).toBe(21); // UTC+9
  });

  test('falls back to local time for a missing or invalid zone', () => {
    const local = instant.getHours() + instant.getMinutes() / 60;
    expect(localHourInTz(undefined, instant).hour).toBe(local);
    expect(localHourInTz('Not/AZone', instant).hour).toBe(local);
  });
});
