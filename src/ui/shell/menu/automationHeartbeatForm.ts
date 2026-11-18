import type { PolarisTriggerRule, PolarisTriggerSchedule } from '../../../types/domain';

export type AutomationScheduleMode = 'once' | 'daily' | 'interval';
export type AutomationDelivery = 'message' | 'silent';

const MINUTE_MS = 60_000;
const MAX_ONCE_DELAY_MS = 30 * 24 * 60 * MINUTE_MS;

/** datetime-local is intentionally rendered in the device's local timezone. */
export function toLocalDateTimeInput(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function earliestOnceInput(now = Date.now()) {
  return toLocalDateTimeInput(Math.ceil((now + MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
}

export function defaultOnceInput(now = Date.now()) {
  return toLocalDateTimeInput(Math.ceil((now + 5 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS);
}

export function buildAutomationSchedule(args: {
  mode: AutomationScheduleMode;
  dailyTime: string;
  intervalMinutes: string;
  onceAt: string;
  now?: number;
}): PolarisTriggerSchedule | null {
  if (args.mode === 'once') {
    const value = args.onceAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const at = new Date(value).getTime();
    const delay = at - (args.now ?? Date.now());
    if (!Number.isFinite(at) || delay < MINUTE_MS || delay > MAX_ONCE_DELAY_MS) return null;
    // Reject impossible dates and device-local times that are skipped during DST.
    if (toLocalDateTimeInput(at) !== value) return null;
    return { kind: 'once', at };
  }
  if (args.mode === 'daily') {
    const value = args.dailyTime.trim();
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minute] = value.split(':');
    return { kind: 'daily', time: `${hour.padStart(2, '0')}:${minute}` };
  }
  const minutes = Number(args.intervalMinutes);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return { kind: 'interval', everyMinutes: Math.floor(minutes) };
}

export function isConsumedOnceRule(rule: Pick<PolarisTriggerRule, 'schedule' | 'nextRunAt' | 'lastRunAt'>) {
  return rule.schedule.kind === 'once' && rule.nextRunAt === null && rule.lastRunAt !== null;
}
