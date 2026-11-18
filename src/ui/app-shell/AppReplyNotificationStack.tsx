import { createPortal } from 'react-dom';
import type { AppReplyNotification } from '../../stores/spaceStoreTypes';
import type { World } from '../../types/domain';
import { Icon } from '../Icon';

type AppReplyNotificationStackProps = {
  notifications: AppReplyNotification[];
  activeWorld: World;
  activeConversationId: string | null;
  onOpen: (notification: AppReplyNotification) => void;
  onDismiss: (notificationId: string) => void;
};

export function AppReplyNotificationStack({
  notifications,
  onOpen,
  onDismiss
}: AppReplyNotificationStackProps) {
  if (notifications.length === 0) return null;

  const content = (
    <div className="app-reply-notification-stack" aria-live="polite">
      {notifications.map((notification) => (
        <article className="app-reply-notification" key={notification.id}>
          <button
            type="button"
            className="app-reply-notification-main"
            onClick={() => onOpen(notification)}
          >
            <span className="app-reply-notification-title">{notification.collaboratorName}</span>
            <span className="app-reply-notification-preview">{notification.preview}</span>
            {notification.nativeDeliveryStatus === 'denied' || notification.nativeDeliveryStatus === 'failed' ? (
              <small>{notification.nativeDeliveryStatus === 'denied' ? '系统通知权限未开启，回复已保留' : '系统通知未送出，回复已保留'}</small>
            ) : null}
          </button>
          <button
            type="button"
            className="app-reply-notification-close"
            onClick={() => onDismiss(notification.id)}
            aria-label="关闭通知"
          >
            <Icon name="x" size={15} />
          </button>
        </article>
      ))}
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
