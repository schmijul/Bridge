export type PresenceState = "online" | "away" | "offline";
export type UserRole = "admin" | "manager" | "member" | "guest";

export interface User {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  lastSeenAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  kind: "channel" | "dm" | "group_dm";
  name: string;
  isPrivate: boolean;
  description: string;
  dmKey?: string;
  archivedAt?: string;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  createdAt: string;
  threadRootMessageId?: string;
  mentionUserIds?: string[];
}

export interface ReadState {
  userId: string;
  channelId: string;
  lastMessageId: string;
}

export interface SyncCursor {
  sequence: number;
}

export interface WorkspaceSettings {
  workspaceName: string;
  messageRetentionDays: number;
  allowGuestAccess: boolean;
  enforceMfaForAdmins: boolean;
}

export interface Workspace {
  id: string;
  settings: WorkspaceSettings;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actorId: string;
  targetType: "channel" | "user" | "message" | "workspace";
  targetId: string;
  summary: string;
  createdAt: string;
}

export type ClientEvent =
  | {
      type: "message:send";
      payload: {
        channelId: string;
        content: string;
        tempId: string;
        threadRootMessageId?: string;
      };
    }
  | {
      type: "presence:update";
      payload: { state: PresenceState };
    }
  | {
      type: "typing:update";
      payload: { channelId: string; isTyping: boolean };
    }
  | {
      type: "read:update";
      payload: { channelId: string; lastMessageId: string };
    };

export type ServerEvent =
  | {
      type: "message:new";
      payload: Message & { sequence: number };
    }
  | {
      type: "message:deleted";
      payload: { messageId: string; channelId: string; sequence: number };
    }
  | {
      type: "channel:created";
      payload: Channel & { sequence: number };
    }
  | {
      type: "channel:updated";
      payload: Channel & { sequence: number };
    }
  | {
      type: "user:updated";
      payload: User & { sequence: number };
    }
  | {
      type: "workspace:updated";
      payload: Workspace & { sequence: number };
    }
  | {
      type: "audit:new";
      payload: AuditLogEntry & { sequence: number };
    }
  | {
      type: "presence:changed";
      payload: { userId: string; state: PresenceState; sequence: number };
    }
  | {
      type: "typing:changed";
      payload: {
        userId: string;
        channelId: string;
        isTyping: boolean;
        sequence: number;
      };
    }
  | {
      type: "read:changed";
      payload: {
        userId: string;
        channelId: string;
        lastMessageId: string;
        sequence: number;
      };
    }
  | {
      type: "sync:snapshot";
      payload: {
        users: User[];
        channels: Channel[];
        messages: Message[];
        onlineUserIds: string[];
        workspace: Workspace;
        cursor: SyncCursor;
      };
    }
  | {
      type: "error";
      payload: { message: string };
    };
