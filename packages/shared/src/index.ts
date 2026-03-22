export type PresenceState = "online" | "away" | "offline";

export interface User {
  id: string;
  displayName: string;
  email: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  isPrivate: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  createdAt: string;
}

export interface ReadState {
  userId: string;
  channelId: string;
  lastMessageId: string;
}

export interface SyncCursor {
  sequence: number;
}

export type ClientEvent =
  | {
      type: "message:send";
      payload: { channelId: string; content: string; tempId: string };
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
        messages: Message[];
        onlineUserIds: string[];
        cursor: SyncCursor;
      };
    }
  | {
      type: "error";
      payload: { message: string };
    };
