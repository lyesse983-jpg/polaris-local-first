import type { PolarisTriggerRule } from '../../types/domain';

export const MAX_AUTONOMOUS_TRIGGER_RUNS_PER_DAY = 12;
export const MAX_AUTONOMOUS_TRIGGER_DURATION_MS = 5 * 60_000;

/** Trigger history is runtime-owned evidence of starts, not model assertions. */
export function getAutonomousTriggerBudgetIssue(rule: PolarisTriggerRule, now = Date.now()) {
  if (rule.action.autonomous !== true) return null;
  const dayAgo = now - 24 * 60 * 60_000;
  const starts = (rule.runHistory ?? []).filter((at) => Number.isFinite(at) && at > dayAgo && at <= now);
  return starts.length >= MAX_AUTONOMOUS_TRIGGER_RUNS_PER_DAY
    ? '这条自主心跳在最近 24 小时已运行 12 次，已暂停；可在主动消息设置中查看和重新安排。'
    : null;
}

export function isSilentTrigger(rule: PolarisTriggerRule) {
  return rule.action.delivery === 'silent';
}
