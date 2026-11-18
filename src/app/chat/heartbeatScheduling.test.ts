import { describe, expect, it, vi } from 'vitest';
import { advanceTriggerRuleAfterRun, createScheduledTriggerRule, getDueTriggerRules, normalizeTriggerRules, markTriggerRuleError } from '../../engines/triggers';
import { updateRuntimeTriggerRule } from '../../stores/runtimeStoreTriggers';
import { createTriggerMessage } from './triggerMessage';
import { getAutonomousTriggerBudgetIssue } from './triggerRunPolicy';

const now = Date.parse('2026-11-18T10:00:00+08:00');
const seed = () => createScheduledTriggerRule({
  now, schedule: { kind: 'once', at: now + 97 * 60_000 },
  target: { collaboratorId: 'test-persona', conversationMode: 'fixed', conversationId: 'c' },
  action: { prompt: '继续相册', autonomous: true, delivery: 'silent' }
});

describe('autonomous one-time heartbeat lifecycle', () => {
  it('fires exactly once and stays consumed after hydration; only a new explicit schedule rearms it', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      const claimed = advanceTriggerRuleAfterRun(seed(), now + 97 * 60_000);
      const restored = normalizeTriggerRules([JSON.parse(JSON.stringify(claimed))])[0];
      expect(restored.enabled).toBe(false);
      expect(restored.nextRunAt).toBeNull();
      expect(getDueTriggerRules([restored], now + 86400_000)).toEqual([]);
      const rearmed = updateRuntimeTriggerRule(restored, { schedule: { kind: 'once', at: now + 8 * 3600_000 } })!;
      expect(rearmed.enabled).toBe(true);
      expect(rearmed.action).toEqual(seed().action);
      expect(rearmed.nextRunAt).toBe(now + 8 * 3600_000);
      expect(markTriggerRuleError(rearmed, '后续请求失败', now + 98 * 60_000).nextRunAt).toBe(rearmed.nextRunAt);
      expect(markTriggerRuleError(rearmed, '失败').runHistory).toEqual(claimed.runHistory);
    } finally { vi.useRealTimers(); }
  });

  it('does not turn corrupted once appointments into recurring daily jobs', () => {
    const damaged = { ...seed(), schedule: { kind: 'once' as const, at: Number.NaN } };
    const restored = normalizeTriggerRules([damaged])[0];
    expect(restored.schedule.kind).toBe('once');
    expect(restored.enabled).toBe(false);
    expect(restored.nextRunAt).toBeNull();
    expect(restored.lastError).toBeTruthy();
  });

  it('can explicitly clear a pending nextRunAt without defaulting it back to a timer', () => {
    const cleared = updateRuntimeTriggerRule(seed(), { nextRunAt: null });
    expect(cleared?.nextRunAt).toBeNull();
  });

  it('bounds actual starts over a rolling day rather than trusting model claims', () => {
    const rule = seed();
    rule.runHistory = Array.from({ length: 12 }, (_, index) => now - index * 60_000);
    expect(getAutonomousTriggerBudgetIssue(rule, now)).toContain('12');
    expect(getAutonomousTriggerBudgetIssue(rule, now + 25 * 3600_000)).toBeNull();
  });

  it('passes original rule id and explicit user-enabled autonomy/silence into the same request stream', () => {
    const rule = seed();
    const message = createTriggerMessage(rule, null);
    expect(message.origin).toBe('trigger-runtime');
    expect(message.requestContent).toContain(rule.id);
    expect(message.requestContent).toContain('用户已在此规则中开启自主续约');
    expect(message.requestContent).toContain('安静做事');
    expect(message.content).not.toContain('updateProactiveMessageRule');
  });
});
