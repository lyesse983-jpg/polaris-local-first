import { useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { getDueTriggerRules } from '../../engines/triggers';
import type { ChatMessage, PolarisTriggerRule } from '../../types/domain';
import type { ChatStoreBindings } from './useChatStoreBindings';
import { createTriggerMessage } from './triggerMessage';
import { resolveTriggerConversationForTarget } from './triggerConversationResolution';
import { buildProactiveReplyNotification } from './proactiveReplyNotification';
import { postNativeProactiveReplyNotification } from '../../native/localTriggerNotifications';
import { selectChatConversations } from './liveConversationCatalog';
import { getAutonomousTriggerBudgetIssue, MAX_AUTONOMOUS_TRIGGER_DURATION_MS } from './triggerRunPolicy';

type TriggerGenerationState = {
  sending: boolean;
};

type UseChatTriggerRuntimeArgs = {
  startupReady: boolean;
  generationByConversationId: Record<string, TriggerGenerationState | undefined>;
  store: ChatStoreBindings;
  runReply: (params: {
    conversationId: string;
    collaboratorId: string;
    messages: ChatMessage[];
    silent?: boolean;
    signal?: AbortSignal;
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

export function useChatTriggerRuntime({
  startupReady,
  generationByConversationId,
  store,
  runReply,
  setCommandStatus
}: UseChatTriggerRuntimeArgs) {
  const runningRuleIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const activeRunRef = useRef<{ conversationId: string; userId: string | null; controller: AbortController; ruleId: string } | null>(null);
  const generationByConversationIdRef = useRef(generationByConversationId);
  const [wakeTick, setWakeTick] = useState(0);

  useEffect(() => {
    generationByConversationIdRef.current = generationByConversationId;
  }, [generationByConversationId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRunRef.current?.controller.abort();
    };
  }, []);


  useEffect(() => {
    const active = activeRunRef.current;
    if (!active) return;
    const latest = store.chat.readLatestState().conversations.find((item) => item.id === active.conversationId);
    const newestUser = latest?.messages.filter((item) => item.role === 'user').slice(-1)[0]?.id ?? null;
    const ruleStillExists = store.runtime.readLatestState().triggerRules.some((item) => item.id === active.ruleId);
    if (!latest || !ruleStillExists || newestUser !== active.userId) active.controller.abort();
  }, [store.chat.conversations, store.runtime.triggerRules]);

  useEffect(() => {
    if (!startupReady || typeof window === 'undefined') return;

    const wake = () => setWakeTick((current) => current + 1);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') wake();
    };

    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    let cancelled = false;
    let removeResumeListener: (() => void) | null = null;

    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('App')) {
      void CapacitorApp.addListener('resume', wake).then((listener) => {
        if (cancelled) {
          void listener.remove();
          return;
        }
        removeResumeListener = () => {
          void listener.remove();
        };
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      removeResumeListener?.();
    };
  }, [startupReady]);

  useEffect(() => {
    if (!startupReady) return;
    const nextRunAt = store.runtime.triggerRules
      .filter((rule) => rule.enabled && rule.nextRunAt !== null)
      .map((rule) => rule.nextRunAt!)
      .sort((left, right) => left - right)[0];
    if (!nextRunAt) return;

    const delay = Math.max(0, nextRunAt - Date.now());
    const timer = window.setTimeout(
      () => setWakeTick((current) => current + 1),
      Math.min(delay, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [startupReady, store.runtime.triggerRules]);

  useEffect(() => {
    if (!startupReady || runningRuleIdRef.current) return;

    const runtimeState = store.runtime.readLatestState();
    const [rule] = getDueTriggerRules(runtimeState.triggerRules);
    if (!rule) return;

    runningRuleIdRef.current = rule.id;

    void (async () => {
      let durationTimer: number | undefined;
      try {
        const budgetIssue = getAutonomousTriggerBudgetIssue(rule);
        if (budgetIssue) {
          store.runtime.updateTriggerRule(rule.id, { enabled: false, nextRunAt: null, lastError: budgetIssue });
          await store.runtime.persistToDb();
          setCommandStatus(budgetIssue, true);
          return;
        }
        const persona = store.persona.readLatestState().personas.find((entry) => entry.id === rule.target.collaboratorId) ?? null;
        if (!persona) {
          store.runtime.markTriggerFailed(rule.id, `目标人格不存在：${rule.target.collaboratorId}`);
          return;
        }

        const conversation = resolveTriggerConversation({ rule, store });
        if (!conversation) {
          store.runtime.markTriggerFailed(rule.id, '无法创建触发器对话');
          return;
        }
        if (generationByConversationIdRef.current[conversation.id]?.sending) {
          return;
        }

        const writableConversation = await store.chat.ensureConversationWritable(conversation.id);
        if (!writableConversation) {
          store.runtime.markTriggerFailed(rule.id, '触发器对话历史还没准备好');
          return;
        }
        // Claim once before any model call, and durably commit through the existing runtime owner.
        // A crash after this boundary leaves an inspectable consumed appointment, not a duplicate send.
        const userId = writableConversation.messages.filter((item) => item.role === 'user').slice(-1)[0]?.id ?? null;
        const controller = new AbortController();
        activeRunRef.current = { conversationId: conversation.id, userId, controller, ruleId: rule.id };
        const freshRule = store.runtime.readLatestState().triggerRules.find((item) => item.id === rule.id);
        if (!freshRule?.enabled || freshRule.nextRunAt !== rule.nextRunAt) return;
        store.runtime.markTriggerFired(rule.id);
        await store.runtime.persistToDb();
        const freshBody = await store.chat.ensureConversationWritable(conversation.id);
        if (!freshBody || controller.signal.aborted || generationByConversationIdRef.current[conversation.id]?.sending) return;
        const latestUserId = freshBody.messages.filter((item) => item.role === 'user').slice(-1)[0]?.id ?? null;
        if (latestUserId !== userId) return;
        const triggerEvent = store.runtime.consumeTriggerEvent(rule.id);
        const triggerMessage = createTriggerMessage(rule, triggerEvent);
        const nextMessages = [...freshBody.messages, triggerMessage];
        const messageCountBeforeReply = nextMessages.length;
        store.chat.addMessage(freshBody, triggerMessage);
        await store.chat.persistToDb();
        setCommandStatus(`心跳已开始：${rule.name}`);
        durationTimer = window.setTimeout(() => controller.abort(), MAX_AUTONOMOUS_TRIGGER_DURATION_MS);

        const result = await runReply({
          conversationId: freshBody.conversationId,
          collaboratorId: rule.target.collaboratorId,
          messages: nextMessages,
          silent: rule.action.delivery === 'silent',
          signal: controller.signal
        });

        if (result.status === 'failed') {
          store.runtime.markTriggerFailed(rule.id, '本次心跳运行失败，已保留工具证据。');
        }
        if (result.status === 'completed' && rule.action.delivery !== 'silent' && mountedRef.current) {
          const latestChatState = store.chat.readLatestState();
          const latestSpaceState = store.space.readLatestState();
          const latestConversation = latestChatState.conversations.find((entry) => entry.id === writableConversation.conversationId) ?? null;
          const notification = buildProactiveReplyNotification({
            conversation: latestConversation,
            collaboratorId: rule.target.collaboratorId,
            collaboratorName: persona.name,
            messageCountBeforeReply,
            currentView: {
              activeWorld: latestSpaceState.activeWorld,
              activeConversationId: latestChatState.activeConversationId
            }
          });
          if (notification) {
            store.space.enqueueReplyNotification(notification);
            void postNativeProactiveReplyNotification(notification);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '触发器执行失败';
        store.runtime.markTriggerFailed(rule.id, message);
        setCommandStatus(`触发器失败：${message}`, true);
      } finally {
        if (durationTimer !== undefined) window.clearTimeout(durationTimer);
        try {
          await store.runtime.persistToDb();
          await store.chat.persistToDb();
        } catch {
          setCommandStatus('心跳记录尚未确认保存，请检查本地数据状态。', true);
        }
        activeRunRef.current = null;
        if (runningRuleIdRef.current === rule.id) {
          runningRuleIdRef.current = null;
          if (mountedRef.current) setWakeTick((tick) => tick + 1);
        }
      }
    })();
  }, [runReply, setCommandStatus, startupReady, store, wakeTick]);
}
