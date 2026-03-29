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
import { getDbPool } from "./db.js";

const workspaceId = "workspace-1";
const persistenceEnabled = process.env.STORE_DRIVER === "postgres" && Boolean(process.env.DATABASE_URL);

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
      content: "Welcome to Bridge. Please use threads for decisions.",
      createdAt: now
    },
    {
      id: "m-2",
      channelId: "c-product",
      senderId: "u-2",
      content: "Release freeze on Friday at 14:00.",
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
let persistQueue: Promise<void> = Promise.resolve();

function enqueuePersist(task: () => Promise<void>): void {
  if (!persistenceEnabled) {
    return;
  }
  persistQueue = persistQueue
    .then(task)
    .catch((error) => {
      console.error("store persistence error", error);
    });
}

function setInMemoryDefaults(now: string): void {
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

async function seedDatabaseFromMemory(): Promise<void> {
  const db = getDbPool();
  await db.query("BEGIN");
  try {
    await db.query("DELETE FROM read_state");
    await db.query("DELETE FROM presence_state");
    await db.query("DELETE FROM messages");
    await db.query("DELETE FROM audit_log");
    await db.query("DELETE FROM channels");
    await db.query("DELETE FROM users");
    await db.query("DELETE FROM workspaces");

    await db.query(
      `INSERT INTO workspaces (id, workspace_name, message_retention_days, allow_guest_access, enforce_mfa_for_admins)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        workspace.id,
        workspace.settings.workspaceName,
        workspace.settings.messageRetentionDays,
        workspace.settings.allowGuestAccess,
        workspace.settings.enforceMfaForAdmins
      ]
    );

    for (const user of users) {
      await db.query(
        `INSERT INTO users (id, display_name, email, role, is_active, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, user.displayName, user.email, user.role, user.isActive, user.lastSeenAt]
      );
    }

    for (const channel of channels) {
      await db.query(
        `INSERT INTO channels (id, workspace_id, name, is_private, description, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          channel.id,
          channel.workspaceId,
          channel.name,
          channel.isPrivate,
          channel.description,
          channel.archivedAt ?? null
        ]
      );
    }

    for (const message of messages) {
      await db.query(
        `INSERT INTO messages (id, channel_id, sender_id, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [message.id, message.channelId, message.senderId, message.content, message.createdAt]
      );
    }

    for (const entry of auditLog) {
      await db.query(
        `INSERT INTO audit_log (id, action, actor_id, target_type, target_id, summary, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.id,
          entry.action,
          entry.actorId,
          entry.targetType,
          entry.targetId,
          entry.summary,
          entry.createdAt
        ]
      );
    }

    for (const [userId, state] of presence.entries()) {
      await db.query(
        `INSERT INTO presence_state (user_id, state, updated_at)
         VALUES ($1, $2, NOW())`,
        [userId, state]
      );
    }

    await db.query("UPDATE event_sequence SET current_value = $1 WHERE id = 1", [sequence]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export function resetStore(): void {
  const now = new Date().toISOString();
  setInMemoryDefaults(now);
  enqueuePersist(seedDatabaseFromMemory);
}

async function loadStoreFromDatabase(): Promise<boolean> {
  if (!persistenceEnabled) {
    return false;
  }

  const db = getDbPool();
  const workspaceResult = await db.query<{
    id: string;
    workspace_name: string;
    message_retention_days: number;
    allow_guest_access: boolean;
    enforce_mfa_for_admins: boolean;
  }>("SELECT * FROM workspaces LIMIT 1");

  if ((workspaceResult.rowCount ?? 0) === 0) {
    return false;
  }

  const workspaceRow = workspaceResult.rows[0];
  workspace.id = workspaceRow.id;
  workspace.settings = {
    workspaceName: workspaceRow.workspace_name,
    messageRetentionDays: workspaceRow.message_retention_days,
    allowGuestAccess: workspaceRow.allow_guest_access,
    enforceMfaForAdmins: workspaceRow.enforce_mfa_for_admins
  };

  const usersResult = await db.query<{
    id: string;
    display_name: string;
    email: string;
    role: UserRole;
    is_active: boolean;
    last_seen_at: Date | string;
  }>("SELECT * FROM users ORDER BY display_name ASC");
  users.splice(
    0,
    users.length,
    ...usersResult.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      isActive: row.is_active,
      lastSeenAt: new Date(row.last_seen_at).toISOString()
    }))
  );

  const channelsResult = await db.query<{
    id: string;
    workspace_id: string;
    name: string;
    is_private: boolean;
    description: string;
    archived_at: Date | string | null;
  }>("SELECT * FROM channels ORDER BY name ASC");
  channels.splice(
    0,
    channels.length,
    ...channelsResult.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      isPrivate: row.is_private,
      description: row.description,
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined
    }))
  );

  const messagesResult = await db.query<{
    id: string;
    channel_id: string;
    sender_id: string;
    content: string;
    created_at: Date | string;
  }>("SELECT * FROM messages ORDER BY created_at ASC");
  messages.splice(
    0,
    messages.length,
    ...messagesResult.rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString()
    }))
  );

  const auditResult = await db.query<{
    id: string;
    action: string;
    actor_id: string;
    target_type: AuditLogEntry["targetType"];
    target_id: string;
    summary: string;
    created_at: Date | string;
  }>("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200");
  auditLog.splice(
    0,
    auditLog.length,
    ...auditResult.rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actor_id,
      targetType: row.target_type,
      targetId: row.target_id,
      summary: row.summary,
      createdAt: new Date(row.created_at).toISOString()
    }))
  );

  const presenceResult = await db.query<{
    user_id: string;
    state: PresenceState;
  }>("SELECT user_id, state FROM presence_state");
  presence.clear();
  for (const row of presenceResult.rows) {
    presence.set(row.user_id, row.state);
  }

  const readResult = await db.query<{
    user_id: string;
    channel_id: string;
    last_message_id: string;
  }>("SELECT user_id, channel_id, last_message_id FROM read_state");
  readState.clear();
  for (const row of readResult.rows) {
    readState.set(`${row.user_id}:${row.channel_id}`, {
      userId: row.user_id,
      channelId: row.channel_id,
      lastMessageId: row.last_message_id
    });
  }

  const sequenceResult = await db.query<{ current_value: number }>(
    "SELECT current_value FROM event_sequence WHERE id = 1"
  );
  sequence = sequenceResult.rows[0]?.current_value ?? 0;
  return true;
}

export async function initStore(): Promise<void> {
  const loaded = await loadStoreFromDatabase();
  if (loaded) {
    return;
  }
  resetStore();
  await persistQueue;
}

resetStore();

function nextSequenceInternal(): number {
  sequence += 1;
  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("UPDATE event_sequence SET current_value = $1 WHERE id = 1", [sequence]);
  });
  return sequence;
}

export function nextSequence(): number {
  return nextSequenceInternal();
}

export function currentSequence(): number {
  return sequence;
}

export function getUserById(userId: string): User | undefined {
  return users.find((user) => user.id === userId);
}

export function getUserByEmail(email: string): User | undefined {
  const normalized = email.trim().toLowerCase();
  return users.find((user) => user.email.toLowerCase() === normalized);
}

export function setPresence(userId: string, state: PresenceState): ServerEvent {
  const now = new Date().toISOString();
  presence.set(userId, state);
  const user = getUserById(userId);
  if (user) {
    user.lastSeenAt = now;
  }

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO presence_state (user_id, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [userId, state]
    );
    await db.query("UPDATE users SET last_seen_at = $2 WHERE id = $1", [userId, now]);
  });

  return {
    type: "presence:changed",
    payload: { userId, state, sequence: nextSequenceInternal() }
  };
}

export function getOnlineUserIds(): string[] {
  return [...presence.entries()]
    .filter(([, state]) => state === "online")
    .map(([userId]) => userId);
}

export function addMessage(channelId: string, senderId: string, content: string): ServerEvent {
  const message: Message = {
    id: randomUUID(),
    channelId,
    senderId,
    content,
    createdAt: new Date().toISOString()
  };
  messages.push(message);

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO messages (id, channel_id, sender_id, content, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [message.id, message.channelId, message.senderId, message.content, message.createdAt]
    );
  });

  return {
    type: "message:new",
    payload: { ...message, sequence: nextSequenceInternal() }
  };
}

export function deleteMessage(messageId: string): ServerEvent | null {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index === -1) {
    return null;
  }
  messages.splice(index, 1);

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("DELETE FROM messages WHERE id = $1", [messageId]);
  });

  return {
    type: "message:deleted",
    payload: { messageId, sequence: nextSequenceInternal() }
  };
}

export function setReadState(userId: string, channelId: string, lastMessageId: string): ServerEvent {
  readState.set(`${userId}:${channelId}`, { userId, channelId, lastMessageId });

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO read_state (user_id, channel_id, last_message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET last_message_id = EXCLUDED.last_message_id`,
      [userId, channelId, lastMessageId]
    );
  });

  return {
    type: "read:changed",
    payload: { userId, channelId, lastMessageId, sequence: nextSequenceInternal() }
  };
}

export function typingChanged(userId: string, channelId: string, isTyping: boolean): ServerEvent {
  return {
    type: "typing:changed",
    payload: { userId, channelId, isTyping, sequence: nextSequenceInternal() }
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

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO channels (id, workspace_id, name, is_private, description, archived_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [channel.id, channel.workspaceId, channel.name, channel.isPrivate, channel.description]
    );
  });

  return {
    type: "channel:created",
    payload: { ...channel, sequence: nextSequenceInternal() }
  };
}

export function archiveChannel(channelId: string): ServerEvent | null {
  const channel = channels.find((item) => item.id === channelId);
  if (!channel) {
    return null;
  }
  channel.archivedAt = new Date().toISOString();

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("UPDATE channels SET archived_at = $2 WHERE id = $1", [channelId, channel.archivedAt]);
  });

  return {
    type: "channel:updated",
    payload: { ...channel, sequence: nextSequenceInternal() }
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

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO users (id, display_name, email, role, is_active, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, user.displayName, user.email, user.role, user.isActive, user.lastSeenAt]
    );
  });

  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequenceInternal() }
  };
}

export function updateUserRole(userId: string, role: UserRole): ServerEvent | null {
  const user = users.find((item) => item.id === userId);
  if (!user) {
    return null;
  }
  user.role = role;

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);
  });

  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequenceInternal() }
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

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("UPDATE users SET is_active = $2 WHERE id = $1", [userId, isActive]);
    if (!isActive) {
      await db.query("DELETE FROM presence_state WHERE user_id = $1", [userId]);
    }
  });

  return {
    type: "user:updated",
    payload: { ...user, sequence: nextSequenceInternal() }
  };
}

export function updateWorkspaceSettings(patch: Partial<WorkspaceSettings>): ServerEvent {
  workspace.settings = {
    ...workspace.settings,
    ...patch
  };

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `UPDATE workspaces
       SET workspace_name = $2,
           message_retention_days = $3,
           allow_guest_access = $4,
           enforce_mfa_for_admins = $5
       WHERE id = $1`,
      [
        workspace.id,
        workspace.settings.workspaceName,
        workspace.settings.messageRetentionDays,
        workspace.settings.allowGuestAccess,
        workspace.settings.enforceMfaForAdmins
      ]
    );
  });

  return {
    type: "workspace:updated",
    payload: { ...workspace, sequence: nextSequenceInternal() }
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

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO audit_log (id, action, actor_id, target_type, target_id, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.id,
        entry.action,
        entry.actorId,
        entry.targetType,
        entry.targetId,
        entry.summary,
        entry.createdAt
      ]
    );
  });

  return {
    type: "audit:new",
    payload: { ...entry, sequence: nextSequenceInternal() }
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
      privateChannels: channels.filter((channel) => channel.isPrivate && !channel.archivedAt).length,
      totalMessages: messages.length
    }
  };
}

export function isPersistenceEnabled(): boolean {
  return persistenceEnabled;
}
