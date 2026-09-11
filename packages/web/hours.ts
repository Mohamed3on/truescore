import { type DayHours, type HoursSlot } from '@truescore/gmaps-shared';

// Local place hours: resolve the current day/hour in the place's own timezone and
// decide whether it's open now — including a closing time past midnight. Pure and
// clock-injectable (localHourInTz takes `now`) so the overnight-wraparound and
// Intl-parsing edge cases are unit-testable. renderHoursToday (client.ts) is the
// DOM sink over these.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// Fractional hours → "9 AM" / "9:30 AM"; 0 and 24 are both midnight.
export function formatHourLabel(h: number): string {
  const hour = Math.floor(h);
  const min = Math.round((h - hour) * 60);
  return `${hour % 12 || 12}${min ? `:${String(min).padStart(2, '0')}` : ''} ${hour % 24 < 12 ? 'AM' : 'PM'}`;
}

// A day's opening slots. Metas cached before `slots` carry only the first
// slot's whole hours.
export const slotsOf = (d: DayHours | undefined): HoursSlot[] =>
  d?.slots ?? (d?.openHour != null && d.closeHour != null ? [[d.openHour, d.closeHour]] : []);

export function localHourInTz(tz: string | undefined, now = new Date()): { day: number; hour: number } {
  const fallback = { day: now.getDay(), hour: now.getHours() + now.getMinutes() / 60 };
  if (!tz) return fallback;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', hour: 'numeric', minute: 'numeric', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const day = WEEKDAYS.indexOf(parts.weekday as typeof WEEKDAYS[number]);
    return {
      day: day >= 0 ? day : fallback.day,
      hour: parseInt(parts.hour!, 10) + parseInt(parts.minute!, 10) / 60,
    };
  } catch {
    return fallback;
  }
}

// A slot closing at or before its open runs past midnight: today it's open from
// its opening to the end of the day, and the part after midnight is judged as
// yesterday's spill — a Sat 18–02 bar is open at 01:00 on Sunday whatever
// Sunday's own hours say, and Tuesday's 18–02 says nothing about Tuesday 01:00.
export function isOpenNow(today: DayHours | undefined, hour: number, yesterday?: DayHours): boolean | null {
  if (slotsOf(yesterday).some(([open, close]) => close <= open && hour < close)) return true;
  if (!today) return null;
  const slots = slotsOf(today);
  if (slots.length) return slots.some(([open, close]) => hour >= open && (close <= open || hour < close));
  if (today.label === 'Closed') return false;
  return null;
}
