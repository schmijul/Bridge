import { randomUUID } from "node:crypto";
import type {
  Channel,
  Message,
  PresenceState,
  ReadState,
  ServerEvent,
  User
} from "@bridge/shared";

const workspaceId = "workspace-1";

export const users: User[] = [
  { id: "u-1", displayName: "Alex", email: "alex@bridge.local" },
  { id: "u-2", displayName: "Sam", email: "sam@bridge.local" }
];

export const channels: Channel[] = [
  { id: "c-general", workspaceId, name: "general", isPrivate: false },
  { id: "c-product", workspaceId, name: "product", isPrivate: false }
];

export const messages: Message[] = [
  {
    id: "m-1",
    channelId: "c-general",
    senderId: "u-1",
    content: "Welcome to Bridge.",
    createdAt: new Date().toISOString()
  }
];

const presence = new Map<string, PresenceState>();
const readState = new Map<string, ReadState>();
let sequence = 0;

export function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export function currentSequence(): number {
  return sequence;
}

export function setPresence(userId: string, state: PresenceState): ServerEvent {
  presence.set(userId, state);
  return {
    type: "presence:changed",
    payload: { userId, state, sequence: nextSequence() }
  };
}

export function getOnlineUserIds(): string[] {
  return [...presence.entries()]
    .filter(([, state]) => state === "online")
    .map(([userId]) => userId);
}

export function addMessage(
  channelId: string,
  senderId: string,
  content: string
): ServerEvent {
  const message: Message = {
    id: randomUUID(),
    channelId,
    senderId,
    content,
    createdAt: new Date().toISOString()
  };
  messages.push(message);
  return {
    type: "message:new",
    payload: { ...message, sequence: nextSequence() }
  };
}

export function setReadState(
  userId: string,
  channelId: string,
  lastMessageId: string
): ServerEvent {
  readState.set(`${userId}:${channelId}`, { userId, channelId, lastMessageId });
  return {
    type: "read:changed",
    payload: { userId, channelId, lastMessageId, sequence: nextSequence() }
  };
}

export function typingChanged(
  userId: string,
  channelId: string,
  isTyping: boolean
): ServerEvent {
  return {
    type: "typing:changed",
    payload: { userId, channelId, isTyping, sequence: nextSequence() }
  };
}
