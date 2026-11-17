import {
  advanceTriggerRuleAfterRun,
  createScheduledTriggerRule,
  markTriggerRuleError,
  normalizeTriggerRules,
  resolveNextTriggerRunAt
} from '../engines/triggers';
import { createUid } from '../engines/id';
import type {
  PolarisTriggerAction,
  PolarisTriggerRule,
  PolarisTriggerSchedule,
  PolarisTriggerTarget
} from '../types/domain';

export type RuntimeTriggerEvent = {
  id: string;
  ruleId: string;
  prompt: string | null;
  source: 'shortcut' | 'notification' | 'manual';
  receivedAt: number;
};

export type RuntimeTriggerState = {
  triggerRules: PolarisTriggerRule[];
  pendingTriggerEvents: RuntimeTriggerEvent[];
};

export const DEFAULT_RUNTIME_TRIGGER_STATE: RuntimeTriggerState = {
  triggerRules: [],
  pendingTriggerEvents: []
};

export function normalizeRuntimeTriggerState(
  state?: Partial<RuntimeTriggerState> | null
): RuntimeTriggerState {
  return {
    triggerRules: normalizeTriggerRules(state?.triggerRules),
    pendingTriggerEvents: []
  };
}

export function createRuntimeTriggerRule(seed: {
  name?: string;
  schedule: PolarisTriggerSchedule;
  target: PolarisTriggerTarget;
  action: PolarisTriggerAction;
}) {
  return createScheduledTriggerRule(seed);
}

export function updateRuntimeTriggerRule(
  rule: PolarisTriggerRule,
  patch: Partial<PolarisTriggerRule>
): PolarisTriggerRule | null {
  const now = Date.now();
  const schedule = patch.schedule ?? rule.schedule;
  const validOnce = schedule.kind !== 'once' || (Number.isFinite(schedule.at) && schedule.at > 0
    && Number.isFinite(new Date(schedule.at).getTime()));
  const nextRunAt = Object.prototype.hasOwnProperty.call(patch, 'nextRunAt')
    ? patch.nextRunAt
    : patch.schedule
      ? (validOnce ? resolveNextTriggerRunAt(schedule, now) : null)
      : rule.nextRunAt;
  const rearmCompletedOnce = patch.schedule !== undefined && rule.schedule.kind === 'once'
    && rule.lastRunAt !== null && validOnce;
  return normalizeTriggerRules([{
    ...rule,
    ...patch,
    target: patch.target ?? rule.target,
    action: patch.action ?? rule.action,
    schedule,
    enabled: patch.enabled ?? (rearmCompletedOnce ? true : rule.enabled),
    nextRunAt,
    updatedAt: now
  }])[0] ?? null;
}

export function markRuntimeTriggerFired(rule: PolarisTriggerRule, runAt = Date.now()) {
  return advanceTriggerRuleAfterRun(rule, runAt);
}

export function markRuntimeTriggerFailed(rule: PolarisTriggerRule, error: string, runAt = Date.now()) {
  return markTriggerRuleError(rule, error, runAt);
}

export function createRuntimeTriggerEvent(seed: {
  ruleId: string;
  prompt?: string | null;
  source: RuntimeTriggerEvent['source'];
}): RuntimeTriggerEvent {
  return {
    id: createUid('trigger-event'),
    ruleId: seed.ruleId,
    prompt: seed.prompt?.trim() || null,
    source: seed.source,
    receivedAt: Date.now()
  };
}
