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
});

describe('isOpenNow', () => {
  const day = (openHour?: number, closeHour?: number, label?: string): DayHours =>
    ({ day: 'Monday', openHour, closeHour, label }) as DayHours;

  test('normal daytime hours (close is exclusive)', () => {
    expect(isOpenNow(day(9, 17), 12)).toBe(true);
    expect(isOpenNow(day(9, 17), 8)).toBe(false);
    expect(isOpenNow(day(9, 17), 17)).toBe(false);
  });

  test('closing after midnight wraps correctly', () => {
    const bar = day(18, 2); // 6pm–2am
    expect(isOpenNow(bar, 23)).toBe(true); // 11pm
    expect(isOpenNow(bar, 1)).toBe(true); // 1am, past midnight
    expect(isOpenNow(bar, 3)).toBe(false); // 3am, after close
    expect(isOpenNow(bar, 15)).toBe(false); // 3pm, before open
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
