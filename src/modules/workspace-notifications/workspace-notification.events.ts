import { EventEmitter } from "node:events";

import type { PublishWorkspaceNotificationInput } from "./workspace-notification.types.js";

const PUBLISH_EVENT = "publish";

export type WorkspaceNotificationDomainEvent = Omit<
  PublishWorkspaceNotificationInput,
  "session"
>;

export type WorkspaceNotificationEventListener = (
  event: WorkspaceNotificationDomainEvent,
) => void;

const emitter = new EventEmitter();

const snapshotEvent = (
  event: WorkspaceNotificationDomainEvent,
): WorkspaceNotificationDomainEvent => ({
  ...event,
  title: { ...event.title },
  message: { ...event.message },
  recipientUserIds: event.recipientUserIds
    ? [...event.recipientUserIds]
    : undefined,
  excludedUserIds: event.excludedUserIds
    ? [...event.excludedUserIds]
    : undefined,
});

/**
 * Emits synchronously after a business operation commits. Subscribers start
 * best-effort delivery without adding notification I/O to the domain service.
 */
export const emitWorkspaceNotificationEvent = (
  event: WorkspaceNotificationDomainEvent,
): boolean => emitter.emit(PUBLISH_EVENT, snapshotEvent(event));

export const onWorkspaceNotificationEvent = (
  listener: WorkspaceNotificationEventListener,
): (() => void) => {
  emitter.on(PUBLISH_EVENT, listener);
  return () => emitter.off(PUBLISH_EVENT, listener);
};
