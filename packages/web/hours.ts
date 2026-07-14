import { type DayHours } from '@truescore/gmaps-shared';

// Local place hours: resolve the current day/hour in the place's own timezone and
// decide whether it's open now — including a closing time past midnight. Pure and
// clock-injectable (localHourInTz takes `now`) so the overnight-wraparound and
// Intl-parsing edge cases are unit-testable. renderHoursToday (client.ts) is the
// DOM sink over these.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function formatHourLabel(h: number): string {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

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

export function isOpenNow(today: DayHours | undefined, hour: number): boolean | null {
  if (!today) return null;
  if (today.openHour != null && today.closeHour != null) {
    const close = today.closeHour <= today.openHour ? today.closeHour + 24 : today.closeHour;
    const cur = hour < today.openHour ? hour + 24 : hour;
    return cur >= today.openHour && cur < close;
  }
  if (today.label === 'Closed') return false;
  return null;
}
