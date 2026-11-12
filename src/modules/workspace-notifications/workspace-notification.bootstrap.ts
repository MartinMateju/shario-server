import { onWorkspaceNotificationEvent } from "./workspace-notification.events.js";
import { publishWorkspaceNotificationSafely } from "./services/workspace-notification-publisher.service.js";

let unregisterPublisher: (() => void) | null = null;

/**
 * Registers one process-local listener. Call this once from app/routes after
 * MongoDB is initialized; workers that emit notification events must register
 * explicitly as part of their own bootstrap.
 */
export const registerWorkspaceNotificationPublisher = (): (() => void) => {
  if (unregisterPublisher) return unregisterPublisher;

  const unsubscribe = onWorkspaceNotificationEvent((event) => {
    void publishWorkspaceNotificationSafely(event);
  });

  unregisterPublisher = () => {
    unsubscribe();
    unregisterPublisher = null;
  };

  return unregisterPublisher;
};
