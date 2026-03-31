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
    },
    {
      id: "u-4",
      displayName: "Jordan",
      email: "jordan@bridge.local",
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
      kind: "channel",
      name: "general",
      isPrivate: false,
      description: "Announcements and cross-team updates"
    },
    {
      id: "c-product",
      workspaceId,
      kind: "channel",
      name: "product",
      isPrivate: false,
      description: "Roadmap, planning and feature delivery"
    },
    {
      id: "c-support",
      workspaceId,
      kind: "channel",
      name: "support",
      isPrivate: false,
      description: "Customer issues and escalation workflow"
    }
  ];
}

function makeInitialMessages(now: string): Message[] {
  const base = new Date(now).getTime();
  const ago = (minutes: number) => new Date(base - minutes * 60_000).toISOString();

  return [
    // --- #general ---
    {
      id: "m-1",
      channelId: "c-general",
      senderId: "u-1",
      content: "Welcome to Bridge! This is our new team workspace. Please keep announcements here and use threads for longer discussions.",
      createdAt: ago(240),
      mentionUserIds: []
    },
    {
      id: "m-2",
      channelId: "c-general",
      senderId: "u-2",
      content: "Looks great @Alex! I've set up the product and support channels already. Everyone should join the ones relevant to their work.",
      createdAt: ago(235),
      mentionUserIds: ["u-1"]
    },
    {
      id: "m-3",
      channelId: "c-general",
      senderId: "u-3",
      content: "Just joined, this is so much better than email threads. Love the clean UI.",
      createdAt: ago(220),
      mentionUserIds: []
    },
    {
      id: "m-4",
      channelId: "c-general",
      senderId: "u-1",
      content: "Quick reminder: all-hands meeting tomorrow at 10am. @Sam will present the Q2 roadmap and @Nina has the support metrics.",
      createdAt: ago(90),
      mentionUserIds: ["u-2", "u-3"]
    },
    // thread reply on m-4
    {
      id: "m-5",
      channelId: "c-general",
      senderId: "u-2",
      content: "Slides are ready, I'll share the deck 30 minutes before.",
      createdAt: ago(85),
      threadRootMessageId: "m-4",
      mentionUserIds: []
    },
    {
      id: "m-6",
      channelId: "c-general",
      senderId: "u-3",
      content: "Support metrics are looking good this quarter. Down 18% on response time!",
      createdAt: ago(80),
      threadRootMessageId: "m-4",
      mentionUserIds: []
    },
    {
      id: "m-7",
      channelId: "c-general",
      senderId: "u-4",
      content: "Hey everyone! Just onboarded today, excited to be here. I'll be working on the frontend for the next sprint.",
      createdAt: ago(45),
      mentionUserIds: []
    },
    // --- #product ---
    {
      id: "m-8",
      channelId: "c-product",
      senderId: "u-2",
      content: "Release freeze is on Friday at 14:00. All PRs need to be merged by Thursday EOD. No exceptions this time.",
      createdAt: ago(180),
      mentionUserIds: []
    },
    {
      id: "m-9",
      channelId: "c-product",
      senderId: "u-1",
      content: "The file upload feature is now in staging. @Jordan can you run the acceptance tests before we cut the release?",
      createdAt: ago(120),
      mentionUserIds: ["u-4"]
    },
    // thread on m-9
    {
      id: "m-10",
      channelId: "c-product",
      senderId: "u-4",
      content: "On it! I'll have results by end of day. Running the full suite now.",
      createdAt: ago(115),
      threadRootMessageId: "m-9",
      mentionUserIds: []
    },
    {
      id: "m-11",
      channelId: "c-product",
      senderId: "u-4",
      content: "All 47 tests passing. One flaky test on large file uploads but it passed on retry. Good to ship.",
      createdAt: ago(60),
      threadRootMessageId: "m-9",
      mentionUserIds: []
    },
    {
      id: "m-12",
      channelId: "c-product",
      senderId: "u-2",
      content: "Sprint velocity is up 15% this iteration. Great work team. Let's keep the momentum going into Q2.",
      createdAt: ago(30),
      mentionUserIds: []
    },
    {
      id: "m-13",
      channelId: "c-product",
      senderId: "u-3",
      content: "Can we add a dark mode toggle to the backlog? Getting requests from a few customers.",
      createdAt: ago(15),
      mentionUserIds: []
    },
    // --- #support ---
    {
      id: "m-14",
      channelId: "c-support",
      senderId: "u-3",
      content: "Heads up: we're seeing increased ticket volume from EU customers about the GDPR export flow. I've drafted a KB article.",
      createdAt: ago(150),
      mentionUserIds: []
    },
    {
      id: "m-15",
      channelId: "c-support",
      senderId: "u-1",
      content: "@Nina great catch. Can you share the article draft? I want to make sure it aligns with our privacy policy language.",
      createdAt: ago(140),
      mentionUserIds: ["u-3"]
    },
    // thread on m-15
    {
      id: "m-16",
      channelId: "c-support",
      senderId: "u-3",
      content: "Shared in the docs folder. The main gap is around data portability timelines — I listed 30 days but legal says 15.",
      createdAt: ago(135),
      threadRootMessageId: "m-15",
      mentionUserIds: []
    },
    {
      id: "m-17",
      channelId: "c-support",
      senderId: "u-1",
      content: "Let's go with 15 days to be safe. Update the article and I'll approve it.",
      createdAt: ago(130),
      threadRootMessageId: "m-15",
      mentionUserIds: []
    },
    {
      id: "m-18",
      channelId: "c-support",
      senderId: "u-4",
      content: "Customer Acme Corp reported a login issue on Safari. I can reproduce it — looks like a cookie SameSite problem. Working on a fix.",
      createdAt: ago(25),
      mentionUserIds: []
    },
    {
      id: "m-19",
      channelId: "c-support",
      senderId: "u-2",
      content: "@Jordan keep me posted on that Safari fix. If it's a blocker we might need a hotfix before Friday.",
      createdAt: ago(10),
      mentionUserIds: ["u-4"]
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
const channelMembership = new Map<string, Set<string>>();
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
  presence.set("u-2", "online");
  presence.set("u-4", "away");
  readState.clear();
  channelMembership.clear();
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
        `INSERT INTO channels (id, workspace_id, kind, name, is_private, description, dm_key, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          channel.id,
          channel.workspaceId,
          channel.kind,
          channel.name,
          channel.isPrivate,
          channel.description,
          channel.dmKey ?? null,
          channel.archivedAt ?? null
        ]
      );
    }

    for (const [channelId, userIds] of channelMembership.entries()) {
      for (const userId of userIds) {
        await db.query(
          `INSERT INTO channel_memberships (channel_id, user_id, added_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channelId, userId]
        );
      }
    }

    for (const message of messages) {
      await db.query(
        `INSERT INTO messages
          (id, channel_id, sender_id, content, created_at, thread_root_message_id, mention_user_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
        [
          message.id,
          message.channelId,
          message.senderId,
          message.content,
          message.createdAt,
          message.threadRootMessageId ?? null,
          message.mentionUserIds ?? []
        ]
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
    kind: Channel["kind"];
    name: string;
    is_private: boolean;
    description: string;
    dm_key: string | null;
    archived_at: Date | string | null;
  }>("SELECT * FROM channels ORDER BY name ASC");
  channels.splice(
    0,
    channels.length,
    ...channelsResult.rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      name: row.name,
      isPrivate: row.is_private,
      description: row.description,
      dmKey: row.dm_key ?? undefined,
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined
    }))
  );

  const messagesResult = await db.query<{
    id: string;
    channel_id: string;
    sender_id: string;
    content: string;
    created_at: Date | string;
    thread_root_message_id: string | null;
    mention_user_ids: string[] | null;
  }>("SELECT * FROM messages ORDER BY created_at ASC");
  messages.splice(
    0,
    messages.length,
    ...messagesResult.rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      senderId: row.sender_id,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
      threadRootMessageId: row.thread_root_message_id ?? undefined,
      mentionUserIds: row.mention_user_ids ?? []
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

  const membershipResult = await db.query<{
    channel_id: string;
    user_id: string;
  }>("SELECT channel_id, user_id FROM channel_memberships");
  channelMembership.clear();
  for (const row of membershipResult.rows) {
    const members = channelMembership.get(row.channel_id) ?? new Set<string>();
    members.add(row.user_id);
    channelMembership.set(row.channel_id, members);
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

export function isUserAllowedInChannel(userId: string, channelId: string): boolean {
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel || channel.archivedAt) {
    return false;
  }
  if (!channel.isPrivate) {
    return true;
  }

  const user = getUserById(userId);
  if (!user || !user.isActive) {
    return false;
  }
  if (channel.kind === "channel" && (user.role === "admin" || user.role === "manager")) {
    return true;
  }

  const members = channelMembership.get(channelId);
  return members?.has(userId) ?? false;
}

export function getChannelsForUser(userId: string): Channel[] {
  return channels.filter((channel) => isUserAllowedInChannel(userId, channel.id));
}

export function getMessagesForUser(userId: string): Message[] {
  return messages.filter((message) => isUserAllowedInChannel(userId, message.channelId));
}

export function getChannelMemberIds(channelId: string): string[] {
  return [...(channelMembership.get(channelId) ?? new Set<string>())];
}

export function addChannelMember(
  channelId: string,
  userId: string
): { ok: true; alreadyMember: boolean } | { ok: false; reason: "channel_not_found" | "channel_not_private" } {
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel || channel.archivedAt) {
    return { ok: false, reason: "channel_not_found" };
  }
  if (!channel.isPrivate || channel.kind !== "channel") {
    return { ok: false, reason: "channel_not_private" };
  }

  const members = channelMembership.get(channelId) ?? new Set<string>();
  const alreadyMember = members.has(userId);
  members.add(userId);
  channelMembership.set(channelId, members);

  if (!alreadyMember) {
    enqueuePersist(async () => {
      const db = getDbPool();
      await db.query(
        `INSERT INTO channel_memberships (channel_id, user_id, added_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channelId, userId]
      );
    });
  }

  return { ok: true, alreadyMember };
}

export function removeChannelMember(
  channelId: string,
  userId: string
): { ok: true; wasMember: boolean } | { ok: false; reason: "channel_not_found" | "channel_not_private" } {
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel || channel.archivedAt) {
    return { ok: false, reason: "channel_not_found" };
  }
  if (!channel.isPrivate || channel.kind !== "channel") {
    return { ok: false, reason: "channel_not_private" };
  }

  const members = channelMembership.get(channelId);
  const wasMember = members?.has(userId) ?? false;
  members?.delete(userId);

  if (members && members.size === 0) {
    channelMembership.delete(channelId);
  }

  if (wasMember) {
    enqueuePersist(async () => {
      const db = getDbPool();
      await db.query("DELETE FROM channel_memberships WHERE channel_id = $1 AND user_id = $2", [
        channelId,
        userId
      ]);
    });
  }

  return { ok: true, wasMember };
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

export function addMessage(
  channelId: string,
  senderId: string,
  content: string,
  options?: { threadRootMessageId?: string; mentionUserIds?: string[] }
): ServerEvent {
  const message: Message = {
    id: randomUUID(),
    channelId,
    senderId,
    content,
    createdAt: new Date().toISOString(),
    threadRootMessageId: options?.threadRootMessageId,
    mentionUserIds: options?.mentionUserIds ?? []
  };
  messages.push(message);
  readState.set(`${senderId}:${channelId}`, {
    userId: senderId,
    channelId,
    lastMessageId: message.id
  });

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO messages
        (id, channel_id, sender_id, content, created_at, thread_root_message_id, mention_user_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
      [
        message.id,
        message.channelId,
        message.senderId,
        message.content,
        message.createdAt,
        message.threadRootMessageId ?? null,
        message.mentionUserIds ?? []
      ]
    );
    await db.query(
      `INSERT INTO read_state (user_id, channel_id, last_message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET last_message_id = EXCLUDED.last_message_id`,
      [senderId, channelId, message.id]
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
  const [removedMessage] = messages.splice(index, 1);

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("DELETE FROM messages WHERE id = $1", [messageId]);
  });

  return {
    type: "message:deleted",
    payload: { messageId, channelId: removedMessage.channelId, sequence: nextSequenceInternal() }
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

export function getUnreadCountsForUser(userId: string): Array<{ channelId: string; unreadCount: number }> {
  const visible = getChannelsForUser(userId);
  const counts: Array<{ channelId: string; unreadCount: number }> = [];

  for (const channel of visible) {
    const channelMessages = messages.filter((message) => message.channelId === channel.id);
    const key = `${userId}:${channel.id}`;
    const lastRead = readState.get(key);
    const startIndex = lastRead
      ? channelMessages.findIndex((message) => message.id === lastRead.lastMessageId) + 1
      : 0;
    const unreadCount = channelMessages
      .slice(Math.max(0, startIndex))
      .filter((message) => message.senderId !== userId).length;
    counts.push({ channelId: channel.id, unreadCount });
  }

  return counts;
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
  creatorId?: string;
}): ServerEvent {
  const channel: Channel = {
    id: `c-${randomUUID()}`,
    workspaceId,
    kind: "channel",
    name: input.name,
    description: input.description,
    isPrivate: input.isPrivate
  };
  channels.push(channel);
  if (channel.isPrivate && input.creatorId) {
    const members = channelMembership.get(channel.id) ?? new Set<string>();
    members.add(input.creatorId);
    channelMembership.set(channel.id, members);
  }

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO channels (id, workspace_id, kind, name, is_private, description, dm_key, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
      [channel.id, channel.workspaceId, channel.kind, channel.name, channel.isPrivate, channel.description]
    );
    if (channel.isPrivate && input.creatorId) {
      await db.query(
        `INSERT INTO channel_memberships (channel_id, user_id, added_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channel.id, input.creatorId]
      );
    }
  });

  return {
    type: "channel:created",
    payload: { ...channel, sequence: nextSequenceInternal() }
  };
}

export function getDirectConversationsForUser(userId: string): Channel[] {
  return getChannelsForUser(userId).filter((channel) => channel.kind === "dm" || channel.kind === "group_dm");
}

export function createDirectConversation(
  actorId: string,
  participantUserIds: string[]
): { channel: Channel; created: boolean; participantIds: string[] } {
  const participants = Array.from(new Set([...participantUserIds, actorId])).sort();
  const kind: Channel["kind"] = participants.length === 2 ? "dm" : "group_dm";
  const dmKey = kind === "dm" ? participants.join(":") : undefined;

  if (dmKey) {
    const existing = channels.find(
      (channel) => channel.kind === "dm" && !channel.archivedAt && channel.dmKey === dmKey
    );
    if (existing) {
      for (const userId of participants) {
        const members = channelMembership.get(existing.id) ?? new Set<string>();
        members.add(userId);
        channelMembership.set(existing.id, members);
      }
      return { channel: existing, created: false, participantIds: participants };
    }
  }

  const suffix = participants.map((id) => id.replace(/^u-/, "")).join("-").slice(0, 28);
  const channel: Channel = {
    id: `c-${randomUUID()}`,
    workspaceId,
    kind,
    name: kind === "dm" ? `dm-${suffix}` : `group-${suffix}`,
    isPrivate: true,
    description: kind === "dm" ? "Direct message conversation" : "Group direct message conversation",
    dmKey
  };
  channels.push(channel);

  for (const userId of participants) {
    const members = channelMembership.get(channel.id) ?? new Set<string>();
    members.add(userId);
    channelMembership.set(channel.id, members);
  }

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query(
      `INSERT INTO channels (id, workspace_id, kind, name, is_private, description, dm_key, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [
        channel.id,
        channel.workspaceId,
        channel.kind,
        channel.name,
        channel.isPrivate,
        channel.description,
        channel.dmKey ?? null
      ]
    );
    for (const userId of participants) {
      await db.query(
        `INSERT INTO channel_memberships (channel_id, user_id, added_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channel.id, userId]
      );
    }
  });

  return { channel, created: true, participantIds: participants };
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

export function runRetentionSweep(nowIso = new Date().toISOString()): {
  deletedCount: number;
  cutoffIso: string;
} {
  const cutoffMs = new Date(nowIso).getTime() - workspace.settings.messageRetentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const beforeCount = messages.length;
  const deletedIds = new Set<string>();
  const keptMessages: Message[] = [];

  for (const message of messages) {
    if (new Date(message.createdAt).getTime() < cutoffMs) {
      deletedIds.add(message.id);
    } else {
      keptMessages.push(message);
    }
  }

  if (deletedIds.size === 0) {
    return { deletedCount: 0, cutoffIso };
  }

  messages.splice(0, messages.length, ...keptMessages);
  for (const [key, state] of readState.entries()) {
    if (deletedIds.has(state.lastMessageId)) {
      readState.delete(key);
    }
  }

  enqueuePersist(async () => {
    const db = getDbPool();
    await db.query("DELETE FROM messages WHERE created_at < $1", [cutoffIso]);
    await db.query(
      "DELETE FROM read_state WHERE last_message_id = ANY($1::text[])",
      [Array.from(deletedIds)]
    );
  });

  return { deletedCount: beforeCount - keptMessages.length, cutoffIso };
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
  const channelMembers = Object.fromEntries(
    channels
      .filter((channel) => channel.isPrivate && !channel.archivedAt)
      .map((channel) => [channel.id, getChannelMemberIds(channel.id)])
  );

  return {
    workspace,
    users,
    channels,
    channelMembers,
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
