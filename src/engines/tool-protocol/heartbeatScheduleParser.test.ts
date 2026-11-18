import { describe, expect, it, vi } from 'vitest';
import { parseAssistantToolAction } from './assistantToolProtocolActionParser';

describe('model-selected one-time heartbeat scheduling', () => {
  it('turns a relative delay into a single persisted appointment', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-18T10:00:00+08:00');
    vi.setSystemTime(now);
    try {
      const result = parseAssistantToolAction({
        kind: 'updateProactiveMessageRule', ruleId: 'heartbeat-1',
        scheduleKind: 'once', afterMinutes: 97, prompt: '接着整理相册'
      });
      expect(result.issue).toBeUndefined();
      expect(result.action).toMatchObject({
        kind: 'updateProactiveMessageRule', ruleId: 'heartbeat-1',
        schedule: { kind: 'once', at: now + 97 * 60_000 }
      });
    } finally { vi.useRealTimers(); }
  });

  it.each([0, -1, 43_201, Number.NaN, '97'])(
    'rejects an invalid relative delay (%s)', (afterMinutes) => {
      const result = parseAssistantToolAction({
        kind: 'updateProactiveMessageRule', ruleId: 'heartbeat-1',
        scheduleKind: 'once', afterMinutes
      });
      expect(result.action).toBeNull();
      expect(result.issue).toBeTruthy();
    }
  );

  it('rejects ambiguous absolute and relative times', () => {
    expect(parseAssistantToolAction({
      kind: 'updateProactiveMessageRule', ruleId: 'heartbeat-1',
      scheduleKind: 'once', afterMinutes: 97, at: Date.now() + 97 * 60_000
    }).action).toBeNull();
  });
});
