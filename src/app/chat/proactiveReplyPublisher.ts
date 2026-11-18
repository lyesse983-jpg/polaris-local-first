import { createUid } from '../../engines/id';
import type { Conversation } from '../../types/domain';
import type { AppReplyNotification, AppReplyNotificationInput } from '../../stores/spaceStoreTypes';
import { buildProactiveReplyNotification } from './proactiveReplyNotification';

type DeliveryStatus = NonNullable<AppReplyNotification['nativeDeliveryStatus']>;

/** Once per heartbeat: notify for committed prose without waiting for all tool follow-ups.
 * Later prose refreshes the in-app preview without repeatedly alerting the phone. */
export function createProactiveReplyPublisher(args: {
  collaboratorId: string;
  collaboratorName: string;
  conversationId: string;
  messageIdsBeforeReply: ReadonlySet<string>;
  getConversation: () => Conversation | null;
  getNotifications: () => AppReplyNotification[];
  enqueue: (notification: AppReplyNotificationInput) => void;
  postNative: (notification: AppReplyNotificationInput) => Promise<DeliveryStatus>;
}) {
  const id = createUid('heartbeat-reply');
  let attemptedNative = false;
  let lastPreview = '';
  let nativeStatus: DeliveryStatus | undefined;
  let delivery: Promise<void> = Promise.resolve();
  return {
    publish: (messageId: string) => {
      const conversation = args.getConversation();
      if (!conversation || conversation.id !== args.conversationId || conversation.collaboratorId !== args.collaboratorId) return;
      const draft = buildProactiveReplyNotification({
        conversation, collaboratorId: args.collaboratorId,
        collaboratorName: args.collaboratorName, messageCountBeforeReply: 0,
        messageIdsBeforeReply: args.messageIdsBeforeReply, committedMessageId: messageId,
        currentView: { activeWorld: 'collection', activeConversationId: null }
      });
      if (!draft || draft.preview === lastPreview) return;
      lastPreview = draft.preview;
      const notification = { ...draft, id, nativeDeliveryStatus: nativeStatus };
      args.enqueue(notification);
      if (attemptedNative) return;
      attemptedNative = true;
      delivery = Promise.resolve().then(() => args.postNative(notification))
        .catch(() => 'failed' as const)
        .then((status) => {
          nativeStatus = status;
          // A dismissed banner must not reappear when an asynchronous delivery settles.
          const current = args.getNotifications().find((item) => item.id === id);
          if (current) args.enqueue({ ...current, nativeDeliveryStatus: status });
        });
    },
    deliverySettled: () => delivery
  };
}
