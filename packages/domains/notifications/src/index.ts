// Domain
export type {
  Notification,
  NotificationKind,
} from "./domain/notification.js";
export { notificationKindIsKnown } from "./domain/notification.js";
export type {
  CommentMentionPayload,
  CommentReplyPayload,
  ShareGrantPayload,
  NotificationPayloadFor,
} from "./domain/event-payloads.js";

// Ports
export type {
  NotificationRepository,
  InsertNotificationInput,
  InsertNotificationResult,
} from "./ports/notification-repository.js";

// Application
export {
  notifyOnce,
  type NotifyOnceInput,
  type NotifyOnceResult,
  type NotifyOnceDeps,
} from "./application/notify-once.js";

// Fakes
export { InMemoryNotificationRepository } from "./application/fakes.js";

// Adapters
export { PostgresNotificationRepository } from "./adapters/postgres/postgres-notification-repository.js";
export {
  startCommentMentionSubscriber,
  type CommentMentionSubscriberOptions,
  type CommentMentionSubscriberHandle,
} from "./adapters/nats/comment-mention-subscriber.js";
export {
  startCommentReplySubscriber,
  type CommentReplySubscriberOptions,
  type CommentReplySubscriberHandle,
} from "./adapters/nats/comment-reply-subscriber.js";
export {
  startShareGrantSubscriber,
  type ShareGrantSubscriberOptions,
  type ShareGrantSubscriberHandle,
} from "./adapters/nats/share-grant-subscriber.js";
