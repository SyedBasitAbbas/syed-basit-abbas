/**
 * Calendar helpers. All business periods are calendar based and evaluated in UTC,
 * so "the 1st of the month" means 00:00:00.000 UTC on day 1.
 */

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function startOfNextUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

/** `YYYY-MM-01`, the key of the calendar month that contains `date`. */
export function monthKey(date: Date): string {
  return startOfUtcMonth(date).toISOString().slice(0, 10);
}

/** `YYYY-MM`, a human readable label of the calendar month. */
export function monthLabel(date: Date): string {
  return monthKey(date).slice(0, 7);
}

/**
 * Adds calendar months and clamps to the last day of the target month,
 * so Jan 31 + 1 month = Feb 28 (or Feb 29 in a leap year). Time of day is kept.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDayOfTargetMonth));
  return target;
}
