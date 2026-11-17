import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types/domain';
import type { ChatReplyStoreBindings } from './chatPorts';
import { createTriggerChatPort } from './silentTriggerChatPort';

function harness(silent: boolean) {
  let messages: ChatMessage[] = [{ id: 'user-1', role: 'user', content: '继续做相册', timestamp: 1 }];
  const chat = {
    addMessage: (_: unknown, message: ChatMessage) => { messages.push(message); },
    updateMessage: (_: unknown, id: string, patch: Partial<ChatMessage>) => {
      messages = messages.map((message) => message.id === id ? { ...message, ...patch } : message);
    },
    insertMessageBefore: (_: unknown, id: string, message: ChatMessage) => {
      const index = messages.findIndex((item) => item.id === id);
      messages.splice(index < 0 ? messages.length : index, 0, message);
    },
    getConversationMessages: () => messages,
    findConversationMessage: (_: unknown, id: string) => messages.find((message) => message.id === id),
    replaceConversationMessages: (_: unknown, next: ChatMessage[]) => { messages = next; }
  } as unknown as ChatReplyStoreBindings['chat'];
  return {
    port: createTriggerChatPort(chat, silent),
    chat,
    rows: () => messages,
    target: { conversationId: 'c', messages, conversation: {} } as never
  };
}

describe('trigger reply persistence projection', () => {
  it('keeps quiet work notes and tool calls replayable without public assistant bubbles or private thinking', () => {
    const h = harness(true);
    h.port.addMessage(h.target, { id: 'answer', role: 'assistant', content: '', timestamp: 2 });
    h.port.updateMessage(h.target, 'answer', {
      content: '已打开两张照片，明早继续排版。', thinkingText: 'hidden reasoning',
      nativeToolCalls: [{ id: 'call-1', name: 'readImage', argumentsText: '{"id":"photo-1"}' }]
    });
    const saved = h.rows().find((row) => row.id === 'answer')!;
    expect(saved.role).toBe('system');
    expect(saved.requestRole).toBe('assistant');
    expect(saved.requestContent).toBe('已打开两张照片，明早继续排版。');
    expect(saved.nativeToolCalls?.[0].name).toBe('readImage');
    expect(saved.thinkingText).toBeUndefined();
    expect(saved.content).toContain('readImage');
    expect(h.port.findConversationMessage('c', 'answer')?.content).toBe(saved.requestContent);
  });

  it.each([true, false])('cancellation preserves a concurrent user message and independently written tool evidence (silent=%s)', (silent) => {
    const h = harness(silent);
    const before = [...h.rows()];
    h.port.addMessage(h.target, { id: 'placeholder', role: 'assistant', content: '', timestamp: 2 });
    h.chat.addMessage(h.target, { id: 'tool-evidence', role: 'system', content: '图片读取成功', timestamp: 3 });
    h.chat.addMessage(h.target, { id: 'user-new', role: 'user', content: '先等等', timestamp: 4 });
    h.port.replaceConversationMessages(h.target, before);
    expect(h.rows().map((row) => row.id)).toEqual(['user-1', 'tool-evidence', 'user-new']);
  });

  it('message mode retains ordinary assistant text', () => {
    const h = harness(false);
    h.port.addMessage(h.target, { id: 'answer', role: 'assistant', content: '我想到一个排版。', timestamp: 2 });
    expect(h.rows()[1].role).toBe('assistant');
    expect(h.rows()[1].content).toBe('我想到一个排版。');
  });
});
