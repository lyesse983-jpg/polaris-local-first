import { describe, expect, it } from 'vitest';
import { buildAutomationSchedule, toLocalDateTimeInput, isConsumedOnceRule } from './automationHeartbeatForm';

const now = new Date(2026, 10, 18, 10, 0).getTime();
const values = { mode: 'once' as const, dailyTime: '09:00', intervalMinutes: '60', onceAt: toLocalDateTimeInput(now + 97 * 60_000), now };

describe('one-time heartbeat form', () => {
  it('preserves device-local time as a concrete epoch timestamp', () => {
    expect(buildAutomationSchedule(values)).toEqual({ kind: 'once', at: now + 97 * 60_000 });
  });
  it('rejects past, invalid, and excessively distant dates', () => {
    expect(buildAutomationSchedule({ ...values, onceAt: toLocalDateTimeInput(now - 60_000) })).toBeNull();
    expect(buildAutomationSchedule({ ...values, onceAt: '2026-02-31T10:00' })).toBeNull();
    expect(buildAutomationSchedule({ ...values, onceAt: toLocalDateTimeInput(now + 31 * 86400_000) })).toBeNull();
  });
  it('recognizes consumed once rules without treating recurring rules as consumed', () => {
    expect(isConsumedOnceRule({ schedule: { kind: 'once', at: now }, nextRunAt: null, lastRunAt: now })).toBe(true);
    expect(isConsumedOnceRule({ schedule: { kind: 'daily', time: '10:00' }, nextRunAt: null, lastRunAt: now })).toBe(false);
  });
});
