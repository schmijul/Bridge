import { randomUUID } from "node:crypto";
import type {
  AuditLogEntry,
  Channel,
  Message,
  PresenceState,
  ReadState,
  ServerEvent,
  User,
  UserRole,
  Workspace,
  WorkspaceSettings
} from "@bridge/shared";

const workspaceId = "workspace-1";

const initialWorkspace: Workspace = {
  id: workspaceId,
  settings: {
    workspaceName: "Bridge Product Team",
    messageRetentionDays: 365,
    allowGuestAccess: false,
    enforceMfaForAdmins: true
  }
};

function makeInitialUsers(now: string): User[] {
  return [
    {
      id: "u-1",
      displayName: "Alex",
      email: "alex@bridge.local",
      role: "admin",
      isActive: true,
      lastSeenAt: now
    },
    {
      id: "u-2",
      displayName: "Sam",
      email: "sam@bridge.local",
      role: "manager",
      isActive: true,
      lastSeenAt: now
    },
    {
      id: "u-3",
      displayName: "Nina",
      email: "nina@bridge.local",
      role: "member",
      isActive: true,
      lastSeenAt: now
    }
  ];
}

function makeInitialChannels(): Channel[] {
  return [
    {
      id: "c-general",
      workspaceId,
      name: "general",
      isPrivate: false,
      description: "Announcements and cross-team updates"
    },
    {
      id: "c-product",
      workspaceId,
      name: "product",
      isPrivate: false,
      description: "Roadmap, planning and feature delivery"
    },
    {
      id: "c-support",
      workspaceId,
      name: "support",
      isPrivate: false,
      description: "Customer issues and escalation workflow"
    }
  ];
}

function makeInitialMessages(now: string): Message[] {
  return [
    {
      id: "m-1",
      channelId: "c-general",
      senderId: "u-1",
      content: "Willkommen bei Bridge. Bitte nutzt Threads fuer Entscheidungen.",
      createdAt: now
    },
    {
      id: "m-2",
      channelId: "c-product",
      senderId: "u-2",
      content: "Release-Freeze am Freitag 14:00 Uhr.",
      createdAt: now
    }
  ];
}

function makeInitialAuditLog(now: string): AuditLogEntry[] {
  return [
    {
      id: randomUUID(),
      action: "workspace.initialized",
      actorId: "u-1",
      targetType: "workspace",
      targetId: workspaceId,
      summary: "Workspace initialized with baseline defaults",
      createdAt: now
    }
  ];
}

export const workspace: Workspace = structuredClone(initialWorkspace);
export const users: User[] = [];
export const channels: Channel[] = [];
export const messages: Message[] = [];
export const auditLog: AuditLogEntry[] = [];

const presence = new Map<string, PresenceState>();
const readState = new Map<string, ReadState>();
let sequence = 0;

export function resetStore(): void {
  const now = new Date().toISOString();

  workspace.settings = structuredClone(initialWorkspace.settings);

  users.splice(0, users.length, ...makeInitialUsers(now));
  channels.splice(0, channels.length, ...makeInitialChannels());
  messages.splice(0, messages.length, ...makeInitialMessages(now));
  auditLog.splice(0, auditLog.length, ...makeInitialAuditLog(now));

  presence.clear();
  presence.set("u-1", "online");
  readState.clear();
  sequence = 0;
}

resetStore();

export function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export function currentSequence(): number {
  return sequence;
}

export function getUserById(userId: string): User | undefined {
  return users.find((user) => user.id === userId);
}

export function setPresence(userId: string, state: PresenceState): ServerEvent {
  presence.set(userId, state);
  const user = getUserById(userId);
  if (user) {
    user.lastSeenAt = new Date().toISOString();
  }
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

export function deleteMessage(messageId: string): ServerEvent | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    return null;
  }
  messages.splice(index, 1);
  return {
    type: "message:deleted",
    payload: { messageId, sequence: nextSequence() }
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

export function createChannel(input: {
  name: string;
  description: string;
  isPrivate: boolean;
}): ServerEvent {
  const channel: Channel = {
    id: `c-${randomUUID()}`,
    workspaceId,
    name: input.name,
    description: input.description,
    isPrivate: input.isPrivate
  };
  channels.push(channel);
  return {
    type: "channel:created",
    payload: { ...channel, sequence: nextSequence() }
  };
}

export function archiveChannel(channelId: string): ServerEvent | null {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) {
    return null;
  }
  channel.archivedAt = new Date().toISOString();
  return {
    type: "channel:updated",
    payload: { ...channel, sequence: nextSequence() }
  };
}

export function inviteUser(input: {
  displayName: string;
  email: string;
  role: UserRole;
}): ServerEvent {
  const user: User = {
    id: `u-${randomUUID()}`,
    displayName: input.displayName,
    email: input.email,
    role: input.role,
    isActive: true,
    lastSeenAt: new Date().toISOString()
  };
  users.push(user);
  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequence() }
  };
}

export function updateUserRole(userId: string, role: UserRole): ServerEvent | null {
  const user = users.find((item) => item.id === userId);
  if (!user) {
    return null;
  }
  user.role = role;
  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequence() }
  };
}

export function setUserActive(userId: string, isActive: boolean): ServerEvent | null {
  const user = users.find((item) => item.id === userId);
  if (!user) {
    return null;
  }
  user.isActive = isActive;
  if (!isActive) {
    presence.delete(user.id);
  }
  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequence() }
  };
}

export function updateWorkspaceSettings(
  patch: Partial<WorkspaceSettings>
): ServerEvent {
  workspace.settings = {
    ...workspace.settings,
    ...patch
  };
  return {
    type: "workspace:updated",
    payload: { ...workspace, sequence: nextSequence() }
  };
}

export function appendAuditLog(input: {
  action: string;
  actorId: string;
  targetType: AuditLogEntry["targetType"];
  targetId: string;
  summary: string;
}): ServerEvent {
  const entry: AuditLogEntry = {
    id: randomUUID(),
    action: input.action,
    actorId: input.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
    summary: input.summary,
    createdAt: new Date().toISOString()
  };
  auditLog.unshift(entry);
  if (auditLog.length > 200) {
    auditLog.length = 200;
  }
  return {
    type: "audit:new",
    payload: { ...entry, sequence: nextSequence() }
  };
}

export function getAdminOverview() {
  return {
    workspace,
    users,
    channels,
    messages,
    auditLog,
    stats: {
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.isActive).length,
      onlineUsers: getOnlineUserIds().length,
      totalChannels: channels.filter((channel) => !channel.archivedAt).length,
      privateChannels: channels.filter((channel) => channel.isPrivate && !channel.archivedAt)
        .length,
      totalMessages: messages.length
    }
  };
}
