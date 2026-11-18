import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../types/domain';
import type { AppReplyNotification } from '../../stores/spaceStoreTypes';
import { createProactiveReplyPublisher } from './proactiveReplyPublisher';

function setup(postNative = vi.fn(async () => 'synced' as const)) {
  const conversation = {id: 'chat', collaboratorId: 'persona', messages: [
    {id: 'old', role: 'assistant', content: 'old reply', timestamp: 1},
    {id: 'trigger', role: 'system', content: 'wake', timestamp: 2}
  ]} as Conversation;
  let notices: AppReplyNotification[] = [];
  const publisher = createProactiveReplyPublisher({
    conversationId: 'chat', collaboratorId: 'persona', collaboratorName: 'Synthetic',
    messageIdsBeforeReply: new Set(['old', 'trigger']), getConversation: () => conversation,
    getNotifications: () => notices,
    enqueue: (notice) => { notices = [{...notice, id: notice.id!, createdAt: 3}]; }, postNative
  });
  return {conversation, publisher, postNative, notices: () => notices, dismiss: () => {notices = [];} };
}

describe('committed heartbeat reply delivery', () => {
  it('waits for real prose when a committed message contains only projected execution code', async () => {
    const s = setup();
    s.conversation.messages.push({id: 'code', role: 'assistant', content: '```js\nawait runSyntheticTool();\n```', timestamp: 3});
    s.publisher.publish('code'); await s.publisher.deliverySettled();
    expect(s.notices()).toEqual([]);
    expect(s.postNative).not.toHaveBeenCalled();
    s.conversation.messages.push({id: 'prose', role: 'assistant', content: '这次有正文了。\n```js\nawait runSyntheticTool();\n```', timestamp: 4});
    s.publisher.publish('prose'); await s.publisher.deliverySettled();
    expect(s.postNative).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({preview: '这次有正文了。'}));
    expect(s.conversation.messages[1].content).toBe('wake');
    expect(s.conversation.messages[2].content).toContain('runSyntheticTool');
  });

  it('notifies committed prose before tool follow-ups finish, once per run, and keeps the app preview current', async () => {
    const s = setup();
    s.conversation.messages.push({id: 'reply1', role: 'assistant', content: 'A real saved reply', timestamp: 3});
    s.publisher.publish('reply1');
    expect(s.notices()[0].preview).toBe('A real saved reply');
    await s.publisher.deliverySettled();
    expect(s.postNative).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({preview: 'A real saved reply'}));
    s.conversation.messages.push({id: 'reply2', role: 'assistant', content: 'A later saved reply after tools', timestamp: 4});
    s.publisher.publish('reply2'); s.publisher.publish('reply2');
    expect(s.notices()[0].preview).toBe('A later saved reply after tools');
    expect(s.postNative).toHaveBeenCalledOnce();
  });

  it('uses message identities when the old history shrinks and never replays an old reply', async () => {
    const s = setup();
    s.publisher.publish('old'); expect(s.notices()).toEqual([]);
    s.conversation.messages = [{id: 'new', role: 'assistant', content: 'New after history compaction', timestamp: 3}];
    s.publisher.publish('new'); await s.publisher.deliverySettled();
    expect(s.notices()[0].preview).toBe('New after history compaction');
    expect(s.postNative).toHaveBeenCalledOnce();
  });

  it('does not revive a dismissed banner when delayed system delivery settles', async () => {
    let resolve!: (status: 'synced') => void;
    const s = setup(vi.fn(() => new Promise<'synced'>((done) => {resolve = done;})));
    s.conversation.messages.push({id: 'reply', role: 'assistant', content: 'Saved', timestamp: 3});
    s.publisher.publish('reply'); await Promise.resolve();
    s.dismiss(); resolve('synced'); await s.publisher.deliverySettled();
    expect(s.notices()).toEqual([]);
  });

  it('keeps the in-app text and reports a system delivery failure separately', async () => {
    const post = vi.fn(async () => {throw new Error('synthetic delivery failure');});
    const s = setup(post);
    s.conversation.messages.push({id: 'reply', role: 'assistant', content: 'Saved despite notification failure', timestamp: 3});
    s.publisher.publish('reply'); await s.publisher.deliverySettled();
    expect(s.notices()[0]).toMatchObject({preview: 'Saved despite notification failure', nativeDeliveryStatus: 'failed'});
  });
});
