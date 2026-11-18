import type { Conversation, World } from '../../types/domain';
import { stripCodeBlocksFromMessage } from '../../engines/codeCardText';
import { TOOL_DRAFT_BLOCK_PATTERN } from './chatMarkdownPatterns';

export type ProactiveReplyNotificationDraft = {
  kind: 'proactive-reply';
  collaboratorId: string;
  collaboratorName: string;
  conversationId: string;
  preview: string;
};

type BuildProactiveReplyNotificationArgs = {
  conversation: Conversation | null;
  collaboratorId: string;
  collaboratorName: string;
  messageCountBeforeReply: number;
  messageIdsBeforeReply?: ReadonlySet<string>;
  committedMessageId?: string;
  currentView: {
    activeWorld: World;
    activeConversationId: string | null;
  };
};

const PREVIEW_MAX_LENGTH = 120;

export function buildReplyPreview(content: string) {
  // Stored messages also contain projected tool code. Keep it in history, but
  // use the same prose/code separation as chat rendering for notifications.
  const prose = stripCodeBlocksFromMessage(content.replace(TOOL_DRAFT_BLOCK_PATTERN, '\n\n'));
  const normalized = prose.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

export function buildProactiveReplyNotification({
  conversation,
  collaboratorId,
  collaboratorName,
  messageCountBeforeReply,
  messageIdsBeforeReply,
  committedMessageId
}: BuildProactiveReplyNotificationArgs): ProactiveReplyNotificationDraft | null {
  if (!conversation) return null;

  const reply = conversation.messages
    .filter((message, index) => (messageIdsBeforeReply ? !messageIdsBeforeReply.has(message.id) : index >= messageCountBeforeReply)
      && (!committedMessageId || message.id === committedMessageId))
    .reverse()
    .find((message) => message.role === 'assistant' && !message.toolInvocation && buildReplyPreview(message.content));
  if (!reply) return null;

  const preview = buildReplyPreview(reply.content);
  if (!preview) return null;

  return {
    kind: 'proactive-reply',
    collaboratorId,
    collaboratorName,
    conversationId: conversation.id,
    preview
  };
}
