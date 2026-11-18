import { describe, expect, it, vi } from 'vitest';
import { createHeartbeatExecutor } from './heartbeatExecutor';
import { createScheduledTriggerRule, advanceTriggerRuleAfterRun } from '../../engines/triggers';
import type { ChatMessage } from '../../types/domain';
vi.mock('../../native/localTriggerNotifications', () => ({postNativeProactiveReplyNotification: vi.fn(async () => 'synced')}));

function setup() {
  const now = Date.now();
  let rule = createScheduledTriggerRule({now: now - 120_000, schedule: {kind: 'once', at: now - 60_000},
    target: {collaboratorId: 'synthetic', conversationMode: 'fixed', conversationId: 'chat'},
    action: {prompt: 'synthetic work', autonomous: true, delivery: 'message'}});
  const appointment = {ruleId: rule.id, scheduledFor: rule.nextRunAt!};
  const conversation = {id: 'chat', collaboratorId: 'synthetic', messages: [] as ChatMessage[]};
  const state = {conversations: [conversation], activeConversationId: 'other'};
  const persist = vi.fn(async (): Promise<void> => undefined);
  const persistRuntime = vi.fn(async () => undefined);
  const notify = vi.fn();
  const runReply = vi.fn(async (request: {signal?: AbortSignal; onAssistantMessageCommitted?: (id: string) => void}) => {
    conversation.messages.push({id: 'reply', role: 'assistant', content: 'Synthetic saved prose', timestamp: now});
    request.onAssistantMessageCommitted?.('reply');
    return {status: 'completed' as const};
  });
  const context = {generationByConversationId: {} as Record<string, {sending: boolean}>, runReply, setCommandStatus: vi.fn(), store: {
    chat: {readLatestState: () => state, ensureConversationWritable: vi.fn(async () => ({conversationId: 'chat', conversation, messages: conversation.messages})),
      addMessage: (_target: unknown, message: ChatMessage) => conversation.messages.push(message), persistToDb: persist},
    persona: {readLatestState: () => ({personas: [{id: 'synthetic', name: 'Synthetic'}]})},
    runtime: {readLatestState: () => ({triggerRules: [rule]}), persistToDb: persistRuntime,
      markTriggerFired: vi.fn(() => {rule = advanceTriggerRuleAfterRun(rule, now);}), consumeTriggerEvent: () => null,
      updateTriggerRule: vi.fn(), markTriggerFailed: vi.fn()},
    space: {readLatestState: () => ({replyNotifications: []}), enqueueReplyNotification: notify}
  }};
  const executor = createHeartbeatExecutor(() => context as never);
  return {context, executor, appointment, conversation, persist, persistRuntime, runReply, notify, getRule: () => rule};
}

describe('shared heartbeat execution without React', () => {
  it('reports committed reply and notification delivery for the owning native session', async () => {
    const s = setup(); const onReplySaved = vi.fn(); const onNotification = vi.fn();
    expect(await s.executor.execute({...s.appointment, onReplySaved, onNotification})).toBe('completed');
    expect(onReplySaved).toHaveBeenCalledOnce(); expect(onNotification).toHaveBeenCalledExactlyOnceWith('synced');
    expect(s.conversation.messages.find(message => message.id === 'reply')?.content).toBe('Synthetic saved prose');
  });

  it('allows only one foreground/native claimant and acknowledges after final storage completes', async () => {
    const s = setup(); let finishSave!: () => void;
    s.persist.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => new Promise<void>(done => {finishSave = done;}));
    let settled = false;
    const first = s.executor.execute(s.appointment).then(result => {settled = true; return result;});
    expect(await s.executor.execute()).toBe('busy');
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
    expect(settled).toBe(false); expect(s.runReply).toHaveBeenCalledOnce();
    finishSave(); expect(await first).toBe('completed');
    expect(s.conversation.messages.filter(message => message.id === 'reply')).toHaveLength(1);
    expect(await s.executor.execute(s.appointment)).toBe('stale');
  });
  it('leaves a busy appointment unclaimed with no persistence retry loop', async () => {
    const s = setup(); s.context.generationByConversationId.chat = {sending: true};
    expect(await s.executor.execute(s.appointment)).toBe('busy');
    expect(s.context.store.runtime.markTriggerFired).not.toHaveBeenCalled();
    expect(s.persist).not.toHaveBeenCalled(); expect(s.persistRuntime).not.toHaveBeenCalled();
    expect(s.getRule().enabled).toBe(true);
  });
  it('rejects a cancelled or changed native appointment', async () => {
    const s = setup();
    expect(await s.executor.execute({...s.appointment, scheduledFor: s.appointment.scheduledFor - 1})).toBe('stale');
    const controller = new AbortController(); controller.abort();
    expect(await s.executor.execute({...s.appointment, signal: controller.signal})).toBe('aborted');
    expect(s.runReply).not.toHaveBeenCalled();
  });
  it('propagates worker cancellation to the existing model/tool signal', async () => {
    const s = setup(); const controller = new AbortController(); let seen: AbortSignal | undefined;
    s.runReply.mockImplementationOnce((request) => new Promise(resolve => {
      seen = request.signal;
      request.signal!.addEventListener('abort', () => resolve({status: 'aborted'} as never), {once: true});
    }));
    const result = s.executor.execute({...s.appointment, signal: controller.signal});
    await vi.waitFor(() => expect(seen).toBeDefined()); controller.abort();
    expect(await result).toBe('aborted'); expect(seen?.aborted).toBe(true); expect(s.notify).not.toHaveBeenCalled();
  });
  it('does not call the model if claiming the appointment cannot be saved', async () => {
    const s = setup(); s.persistRuntime.mockRejectedValueOnce(new Error('synthetic storage failure'));
    expect(await s.executor.execute(s.appointment)).toBe('failed');
    expect(s.runReply).not.toHaveBeenCalled();
  });
  it('cancels on a new user message and supports silent work without reply notifications', async () => {
    const s = setup(); let signal: AbortSignal | undefined;
    s.runReply.mockImplementationOnce(request => new Promise(resolve => {
      signal = request.signal; signal!.addEventListener('abort', () => resolve({status: 'aborted'} as never), {once: true});
    }));
    const run = s.executor.execute(s.appointment); await vi.waitFor(() => expect(signal).toBeDefined());
    s.conversation.messages.push({id: 'new-user', role: 'user', content: 'synthetic user input', timestamp: Date.now()});
    s.executor.cancelIfInvalid(); expect(await run).toBe('aborted');
    const silent = setup(); silent.getRule().action.delivery = 'silent';
    expect(await silent.executor.execute(silent.appointment)).toBe('completed');
    expect(silent.runReply).toHaveBeenCalledWith(expect.objectContaining({silent: true, onAssistantMessageCommitted: undefined}));
    expect(silent.notify).not.toHaveBeenCalled();
  });
});
