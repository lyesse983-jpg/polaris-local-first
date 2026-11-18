import { getDueTriggerRules } from '../../engines/triggers';
import type { ChatMessage, PolarisTriggerRule } from '../../types/domain';
import type { ChatStoreBindings } from './useChatStoreBindings';
import { createTriggerMessage } from './triggerMessage';
import { resolveTriggerConversationForTarget } from './triggerConversationResolution';
import { createProactiveReplyPublisher } from './proactiveReplyPublisher';
import { postNativeProactiveReplyNotification } from '../../native/localTriggerNotifications';
import { selectChatConversations } from './liveConversationCatalog';
import { getAutonomousTriggerBudgetIssue, MAX_AUTONOMOUS_TRIGGER_DURATION_MS } from './triggerRunPolicy';

export type HeartbeatExecutionContext = {
  generationByConversationId: Record<string, { sending: boolean } | undefined>;
  store: ChatStoreBindings;
  runReply: (params: {
    conversationId: string;
    collaboratorId: string;
    messages: ChatMessage[];
    silent?: boolean;
    signal?: AbortSignal;
    onAssistantMessageCommitted?: (messageId: string) => void;
  }) => Promise<{ status: 'completed' | 'aborted' | 'failed' }>;
  setCommandStatus: (text: string, isError?: boolean) => void;
};

function resolveTriggerConversation(args: {
  rule: PolarisTriggerRule;
  store: ChatStoreBindings;
}) {
  const chatState = args.store.chat.readLatestState();
  const liveConversations = selectChatConversations(chatState.conversations);
  return resolveTriggerConversationForTarget(args.rule.target, {
    conversations: liveConversations,
    activeConversationId: chatState.activeConversationId
  }, {
    createConversation: (collaboratorId) => args.store.chat.createConversation(collaboratorId),
    getConversations: () => {
      const latest = args.store.chat.readLatestState();
      return selectChatConversations(latest.conversations);
    }
  });
}

export type HeartbeatExecutionResult = 'completed' | 'aborted' | 'failed' | 'busy' | 'stale';

/** One owner shared by JS timers and Android workers. No React, navigation, or second data store. */
export function createHeartbeatExecutor(getContext: () => HeartbeatExecutionContext) {
  let active: { conversationId: string; userId: string | null; controller: AbortController; ruleId: string } | null = null;
  let running = false;
  let disposed = false;
  return {
    activate: () => { disposed = false; },
    dispose: () => { disposed = true; active?.controller.abort(); },
    cancelIfInvalid: () => {
      if (!active) return;
      const {store} = getContext();
      const latest = store.chat.readLatestState().conversations.find(item => item.id === active!.conversationId);
      const userId = latest?.messages.filter(item => item.role === 'user').slice(-1)[0]?.id ?? null;
      if (!latest || userId !== active.userId || !store.runtime.readLatestState().triggerRules.some(item => item.id === active!.ruleId)) active.controller.abort();
    },
    execute: async (request: { ruleId?: string; scheduledFor?: number; signal?: AbortSignal; onReplySaved?: () => void; onNotification?: (delivery: string) => void } = {}): Promise<HeartbeatExecutionResult> => {
      if (disposed || request.signal?.aborted) return 'aborted';
      if (running) return 'busy';
      const {store, runReply, setCommandStatus} = getContext();
      const rules = getDueTriggerRules(store.runtime.readLatestState().triggerRules);
      const rule = request.ruleId ? rules.find(item => item.id === request.ruleId && item.nextRunAt === request.scheduledFor) : rules[0];
      if (!rule) return 'stale';
      running = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal?.addEventListener('abort', abort, {once: true});
      let timer: ReturnType<typeof setTimeout> | undefined;
      let shouldPersist = false;
      let outcome: HeartbeatExecutionResult = 'failed';
      try {
        const budget = getAutonomousTriggerBudgetIssue(rule);
        if (budget) {
          store.runtime.updateTriggerRule(rule.id, {enabled: false, nextRunAt: null, lastError: budget});
          shouldPersist = true; setCommandStatus(budget, true); return outcome;
        }
        const persona = store.persona.readLatestState().personas.find(item => item.id === rule.target.collaboratorId);
        if (!persona) { shouldPersist = true; store.runtime.markTriggerFailed(rule.id, '目标人格不存在'); return outcome; }
        const conversation = resolveTriggerConversation({rule, store});
        if (!conversation) { shouldPersist = true; store.runtime.markTriggerFailed(rule.id, '无法创建触发器对话'); return outcome; }
        if (getContext().generationByConversationId[conversation.id]?.sending) return 'busy';
        const body = await store.chat.ensureConversationWritable(conversation.id);
        if (!body) { shouldPersist = true; store.runtime.markTriggerFailed(rule.id, '触发器对话历史还没准备好'); return outcome; }
        if (controller.signal.aborted || disposed) return 'aborted';
        if (getContext().generationByConversationId[conversation.id]?.sending) return 'busy';
        const userId = body.messages.filter(item => item.role === 'user').slice(-1)[0]?.id ?? null;
        active = {conversationId: conversation.id, userId, controller, ruleId: rule.id};
        const fresh = store.runtime.readLatestState().triggerRules.find(item => item.id === rule.id);
        if (!fresh?.enabled || fresh.nextRunAt !== rule.nextRunAt) return 'stale';
        shouldPersist = true;
        store.runtime.markTriggerFired(rule.id);
        await store.runtime.persistToDb();
        const current = await store.chat.ensureConversationWritable(conversation.id);
        if (!current || controller.signal.aborted || disposed || getContext().generationByConversationId[conversation.id]?.sending) return 'aborted';
        if ((current.messages.filter(item => item.role === 'user').slice(-1)[0]?.id ?? null) !== userId) return 'aborted';
        const message = createTriggerMessage(rule, store.runtime.consumeTriggerEvent(rule.id));
        const messages = [...current.messages, message];
        store.chat.addMessage(current, message);
        await store.chat.persistToDb();
        setCommandStatus(`心跳已开始：${rule.name}`);
        timer = setTimeout(abort, MAX_AUTONOMOUS_TRIGGER_DURATION_MS);
        const publisher = rule.action.delivery === 'silent' ? null : createProactiveReplyPublisher({
          collaboratorId: rule.target.collaboratorId, collaboratorName: persona.name,
          conversationId: conversation.id, messageIdsBeforeReply: new Set(messages.map(item => item.id)),
          getConversation: () => store.chat.readLatestState().conversations.find(item => item.id === conversation.id) ?? null,
          getNotifications: () => store.space.readLatestState().replyNotifications ?? [],
          enqueue: notification => { if (!disposed) store.space.enqueueReplyNotification(notification); },
          postNative: async notification => {
            const delivery = await postNativeProactiveReplyNotification(notification);
            request.onNotification?.(delivery); return delivery;
          }
        });
        const result = await runReply({conversationId: current.conversationId, collaboratorId: rule.target.collaboratorId,
          messages, silent: rule.action.delivery === 'silent', signal: controller.signal,
          onAssistantMessageCommitted: publisher ? id => { if (!disposed) { request.onReplySaved?.(); publisher.publish(id); } } : undefined});
        outcome = result.status;
        if (outcome === 'failed') store.runtime.markTriggerFailed(rule.id, '本次心跳运行失败，已保留工具证据。');
        if (outcome === 'aborted') store.runtime.markTriggerFailed(rule.id, '本次心跳被中止，尚未确认回复完成。');
        // Native worker acknowledgement comes after both storage and notification delivery settle.
        await publisher?.deliverySettled();
      } catch {
        outcome = controller.signal.aborted ? 'aborted' : 'failed';
        store.runtime.markTriggerFailed(rule.id, '本次心跳执行失败，请检查模型或工具连接。');
        shouldPersist = true;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        try {
          if (shouldPersist) { await store.runtime.persistToDb(); await store.chat.persistToDb(); }
        } catch { outcome = 'failed'; setCommandStatus('心跳记录尚未确认保存，请检查本地数据状态。', true); }
        active = null; running = false;
      }
      return outcome;
    }
  };
}
