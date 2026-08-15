export interface LoggedAttachment {
    id: string;
    name: string;
    contentType?: string;
    size: number;
    url: string;
    proxyUrl: string;
}

export interface MessageSnapshot {
    version: 1;
    messageId: string;
    guildId: string;
    channelId: string;
    channelName?: string;
    parentChannelId?: string;
    parentChannelName?: string;
    authorId: string;
    authorLabel: string;
    createdAtMs: number;
    editedAtMs?: number;
    content: string;
    attachments: LoggedAttachment[];
    imageUrls: string[];
    jumpUrl: string;
}

export interface DeleteAttribution {
    kind: "internal" | "moderator" | "unknown";
    actorId?: string;
    actorLabel?: string;
    reason?: string;
}

export type MessageLogEvent =
    | {
          version: 1;
          eventId: string;
          kind: "edit";
          occurredAtMs: number;
          before?: MessageSnapshot;
          after: MessageSnapshot;
      }
    | {
          version: 1;
          eventId: string;
          kind: "delete";
          occurredAtMs: number;
          snapshot: MessageSnapshot;
      }
    | {
          version: 1;
          eventId: string;
          kind: "bulk-delete";
          occurredAtMs: number;
          guildId: string;
          channelId: string;
          snapshots: MessageSnapshot[];
          missingMessageIds: string[];
      };

export interface MessageLoggingMetrics {
    captured: number;
    editsQueued: number;
    deletesQueued: number;
    bulkDeletesQueued: number;
    sent: number;
    retries: number;
    sendFailures: number;
    storeErrors: number;
    dropped: number;
    unattributed: number;
    snapshots: number;
    pending: number;
}

export interface StoredOutboxEvent {
    event: MessageLogEvent;
    attempts: number;
}
