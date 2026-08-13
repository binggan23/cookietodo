import type { Recurrence } from "../domain/types";

let RRuleClass: unknown = null;
async function rruleClass(): Promise<{
  DAILY: number;
  WEEKLY: number;
  MONTHLY: number;
  [key: string]: unknown;
}> {
  if (RRuleClass === null) {
    const mod = await import("rrule");
    RRuleClass = mod.RRule;
  }
  return RRuleClass as { DAILY: number; WEEKLY: number; MONTHLY: number; [key: string]: unknown };
}

export async function computeNextTriggerAt(
  recurrence: Recurrence,
  anchorMoment: number,
  previousTriggerAt: number,
): Promise<number | null> {
  const RRule = await rruleClass();

  const freq =
    recurrence.kind === "daily"
      ? RRule.DAILY
      : recurrence.kind === "weekly"
        ? RRule.WEEKLY
        : RRule.MONTHLY;

  const rruleOpts: Record<string, unknown> = {
    freq,
    interval: recurrence.interval,
    dtstart: new Date(anchorMoment),
  };

  if (recurrence.kind === "weekly" && recurrence.weekdayMask !== null) {
    const weekdays: unknown[] = [];
    const namesArr = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    for (let i = 0; i < 7; i++) {
      if (recurrence.weekdayMask & (1 << i)) {
        const n = namesArr[i];
        if (n) weekdays.push(RRule[n]);
      }
    }
    rruleOpts.byweekday = weekdays;
  }

  if (
    recurrence.kind === "monthly" &&
    recurrence.daysOfMonth !== null &&
    recurrence.daysOfMonth.length > 0
  ) {
    rruleOpts.bymonthday = recurrence.daysOfMonth;
  }

  if (
    recurrence.kind === "monthly" &&
    recurrence.nthWeekday !== null &&
    recurrence.nthWeekday.length > 0
  ) {
    const namesArr = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    rruleOpts.byweekday = recurrence.nthWeekday.map((nw) => {
      const dayKey = namesArr[nw.weekday];
      if (!dayKey) return RRule.MO;
      const wd = RRule[dayKey] as { nth: (n: number) => unknown };
      return wd.nth ? wd.nth(nw.n) : RRule.MO;
    });
  }

  if (recurrence.count !== null) rruleOpts.count = recurrence.count;
  if (recurrence.until !== null) rruleOpts.until = new Date(recurrence.until);

  try {
    const RuleConstructor = RRule as unknown as new (
      opts: Record<string, unknown>,
    ) => { after: (dt: Date, inc: boolean) => Date | null };
    const rule = new RuleConstructor(rruleOpts);
    // For anchor='due', dtstart = anchorMoment = previousTriggerAt.
    // We want occurrences STRICTLY AFTER previousTriggerAt.
    // rrule.after() with inc=false returns the first occurrence strictly after
    // the given date. When anchor='due', prevTrigger === dtstart, so after()
    // skips dtstart and returns the next one. Good.
    // For anchor='completed', dtstart = anchorMoment = completedAt (which may be
    // later than previousTriggerAt). We want the first occurrence after
    // completedAt (not after previousTriggerAt), to skip dtstart itself.
    const afterDt = recurrence.anchor === "completed" ? anchorMoment : previousTriggerAt;
    const next = rule.after(new Date(afterDt + 1), false); // +1 to be strictly after
    if (next === null) return null;
    const nextMs = next.getTime();
    return nextMs <= previousTriggerAt ? null : nextMs;
  } catch {
    return null;
  }
}
