import type { ChatMessage } from '../../types/domain';
import type { ChatReplyStoreBindings } from './chatPorts';
import type { RequestReplyChatPort } from './chatReplyRuntime';

/** Keep actual tool exchanges and final work notes in the original conversation,
 * without rendering streamed conversational bubbles or publishing a notification.
 * requestRole/requestContent preserve the same provider replay semantics as triggers.
 */
export function createTriggerChatPort(chat: ChatReplyStoreBindings['chat'], silent = false): RequestReplyChatPort {
  const generatedIds = new Set<string>();
  const originals = new Map<string, ChatMessage>();
  const project = (message: ChatMessage): ChatMessage => {
    if (!silent || message.role !== 'assistant' || message.toolInvocation) return message;
    originals.set(message.id, message);
    const names = message.nativeToolCalls?.map((call) => call.name).join('、');
    return {
      ...message,
      role: 'system',
      origin: 'trigger-runtime',
      content: names ? `（安静心跳 · 调用工具：${names}）` : '（安静心跳 · 运行记录）',
      requestRole: 'assistant',
      requestContent: message.requestContent ?? message.content,
      thinkingText: undefined
    };
  };
  const original = (message: ChatMessage) => originals.get(message.id) ?? message;
  return {
    ...chat,
    addMessage: (target, message) => {
      generatedIds.add(message.id);
      chat.addMessage(target, project(message));
    },
    insertMessageBefore: (target, beforeId, message) => {
      generatedIds.add(message.id);
      chat.insertMessageBefore(target, beforeId, project(message));
    },
    updateMessage: (target, id, patch) => {
      const current = originals.get(id) ?? chat.findConversationMessage(target.conversationId, id);
      if (!current) return;
      const next = { ...current, ...patch };
      if (generatedIds.has(id)) chat.updateMessage(target, id, project(next));
      else chat.updateMessage(target, id, patch);
    },
    getConversationMessages: (id) => chat.getConversationMessages(id).map(original),
    findConversationMessage: (conversationId, id) => {
      const row = chat.findConversationMessage(conversationId, id);
      return row ? original(row) : undefined;
    },
    replaceConversationMessages: (target, desired) => {
      // Reply cancellation may supply the history from the start of the run.
      // Remove only this run's omitted generated messages; preserve newer user input
      // and independently committed tool evidence from the latest complete source.
      const wanted = new Map(desired.map((message) => [message.id, message]));
      const latest = chat.getConversationMessages(target.conversationId);
      chat.replaceConversationMessages(target, latest.flatMap((message) => {
        if (!generatedIds.has(message.id)) return [message];
        const replacement = wanted.get(message.id);
        return replacement ? [project(replacement)] : [];
      }));
    }
  };
}

export function createSilentTriggerChatPort(chat: ChatReplyStoreBindings['chat']): RequestReplyChatPort {
  return createTriggerChatPort(chat, true);
}
