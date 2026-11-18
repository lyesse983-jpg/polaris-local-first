import { afterEach, expect, it, vi } from 'vitest';
import { createScheduledTriggerRule, advanceTriggerRuleAfterRun } from '../../engines/triggers';
import type { ChatMessage } from '../../types/domain';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', () => ({
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(value: T) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect)
}));
vi.mock('@capacitor/core', () => ({ Capacitor: {isNativePlatform: () => false} }));
vi.mock('../../native/localTriggerNotifications', () => ({ postNativeProactiveReplyNotification: vi.fn(async () => true) }));
import { useChatTriggerRuntime } from './useChatTriggerRuntime';

afterEach(() => {hooks.effects.length = 0; vi.useRealTimers(); vi.unstubAllGlobals();});

it('runs and stores a due heartbeat in another conversation while staying outside that conversation', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  let rule = createScheduledTriggerRule({ now: now - 120_000,
    schedule: { kind: 'once', at: now - 60_000 },
    target: { collaboratorId: 'synthetic-persona', conversationMode: 'fixed', conversationId: 'target' },
    action: { prompt: 'synthetic heartbeat', autonomous: true, delivery: 'message' }
  });
  const conversation = {id: 'target', collaboratorId: 'synthetic-persona', activeProjectId: null,
    title: 'Target', draft: '', pinnedAt: null, updatedAt: 1, messages: [] as ChatMessage[]};
  const chatState = {conversations: [conversation], activeConversationId: 'some-other-conversation'};
  const writable = () => ({conversationId: 'target', conversation, messages: conversation.messages});
  const persistChat = vi.fn(async () => undefined);
  const notification = vi.fn();
  const navigate = vi.fn();
  vi.stubGlobal('window', {setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn()});
  vi.stubGlobal('document', {visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn()});
  const runReply = vi.fn(async () => {
    conversation.messages.push({id: 'reply', role: 'assistant', content: 'Written without opening target view', timestamp: now});
    return {status: 'completed' as const};
  });
  const markFailed = vi.fn();
  useChatTriggerRuntime({startupReady: true, generationByConversationId: {}, runReply,
    setCommandStatus: vi.fn(), store: {
      chat: {readLatestState: () => chatState, ensureConversationWritable: vi.fn(async () => writable()),
        createConversation: navigate, setActiveConversation: navigate, persistToDb: persistChat,
        addMessage: (_target: unknown, message: ChatMessage) => conversation.messages.push(message)},
      runtime: {readLatestState: () => ({triggerRules: [rule]}), triggerRules: [rule],
        markTriggerFired: () => {rule = advanceTriggerRuleAfterRun(rule, now);},
        consumeTriggerEvent: vi.fn(() => null), markTriggerFailed: markFailed, persistToDb: vi.fn(async () => undefined)},
      persona: {readLatestState: () => ({personas: [{id: 'synthetic-persona', name: 'Synthetic'}]})},
      space: {readLatestState: () => ({activeWorld: 'collection'}), enqueueReplyNotification: notification}
    } as never
  });
  const cleanups = hooks.effects.map(effect => effect());
  for (let i = 0; i < 25; i++) await Promise.resolve();
  expect(runReply).toHaveBeenCalledOnce();
  expect(conversation.messages.some(message => message.id === 'reply')).toBe(true);
  expect(persistChat).toHaveBeenCalled();
  expect(markFailed).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(chatState.activeConversationId).toBe('some-other-conversation');
  expect(notification).toHaveBeenCalledWith(expect.objectContaining({conversationId: 'target'}));
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
});
