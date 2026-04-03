import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  AuditLogEntry,
  Channel,
  ClientEvent,
  Message,
  PresenceState,
  ServerEvent,
  User,
  UserRole,
  Workspace
} from "@bridge/shared";

type Tab = "chat" | "admin";

type AdminOverview = {
  workspace: Workspace;
  users: User[];
  channels: Channel[];
  channelMembers: Record<string, string[]>;
  messages: Message[];
  auditLog: AuditLogEntry[];
  stats: {
    totalUsers: number;
    activeUsers: number;
    onlineUsers: number;
    totalChannels: number;
    privateChannels: number;
    totalMessages: number;
  };
};

type BootstrapPayload = {
  users: User[];
  channels: Channel[];
  messages: Message[];
  onlineUserIds: string[];
  workspace: Workspace;
  cursor: { sequence: number };
};

type MePayload = {
  user: User;
};

type UnreadPayload = {
  totalUnread: number;
  channels: Array<{ channelId: string; unreadCount: number }>;
};

type CreateConversationResponse = {
  conversation: Channel;
  participantIds: string[];
};

type SearchResult = Message & {
  senderDisplayName: string;
  channelName: string;
};

type SearchPayload = {
  query: string;
  count: number;
  results: SearchResult[];
};

type UploadAttachmentResponse = {
  attachment: Attachment;
};

type BotManagementEntry = User & {
  activeTokenCount: number;
  lastTokenCreatedAt: string | null;
  isBot: true;
};

type BotManagementPayload = {
  bots: BotManagementEntry[];
};

type BotManagementResponse = {
  bot: BotManagementEntry;
  token: string;
};

type BotTokenRevocationResponse = {
  bot: BotManagementEntry;
  revokedTokenCount: number;
};

type PendingAttachment = Attachment & {
  uploadState: "uploading" | "ready" | "error";
  errorMessage?: string;
};

type BotTokenReveal = {
  botId: string;
  botName: string;
  action: "created" | "rotated";
  token: string;
};

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";

function attachmentDownloadUrl(attachmentId: string): string {
  return `${apiBase}/attachments/${attachmentId}/download`;
}

const roleOrder: UserRole[] = ["admin", "manager", "member", "guest"];

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60);
    return `${m}m ago`;
  }
  if (diffSec < 86400) {
    const h = Math.floor(diffSec / 3600);
    return `${h}h ago`;
  }
  const d = Math.floor(diffSec / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function channelTitle(channel: Channel | null, users: User[], currentUserId: string): string {
  if (!channel) {
    return "unknown";
  }
  if (channel.kind === "channel") {
    return `#${channel.name}`;
  }

  const suffix = channel.name.replace(/^(dm|group)-/, "");
  const ids = suffix
    .split("-")
    .filter(Boolean)
    .map((part) => (part.startsWith("u-") ? part : `u-${part}`))
    .filter((id) => id !== currentUserId);
  const names = ids
    .map((id) => users.find((user) => user.id === id)?.displayName)
    .filter((name): name is string => Boolean(name));

  if (names.length > 0) {
    return names.join(", ");
  }
  return channel.kind === "dm" ? "Direct Message" : "Group Conversation";
}

function formatTypingLabel(userIds: string[], users: User[]): string {
  const names = userIds
    .map((userId) => users.find((user) => user.id === userId)?.displayName ?? "Someone")
    .slice(0, 3);
  if (names.length === 0) {
    return "";
  }
  if (names.length === 1) {
    return `${names[0]} is typing...`;
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing...`;
  }
  return `${names[0]}, ${names[1]} and others are typing...`;
}

function renderMessageContent(content: string) {
  return content.split(/(@[a-z0-9_.-]{2,32})/gi).map((part, index) =>
    part.startsWith("@") ? (
      <span className="mentionToken" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kb = sizeBytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function canInlineImage(mimeType: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].includes(
    mimeType.toLowerCase()
  );
}

function buildPresenceSnapshot(users: User[], onlineUserIds: string[]): Record<string, PresenceState> {
  return Object.fromEntries(
    users.map((user) => [user.id, onlineUserIds.includes(user.id) ? "online" : "offline"])
  );
}

export function App() {
  const initialTab: Tab =
    new URLSearchParams(window.location.search).get("tab") === "admin" ? "admin" : "chat";
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [totalUnread, setTotalUnread] = useState(0);
  const [typingByChannel, setTypingByChannel] = useState<Record<string, string[]>>({});
  const [channelMembers, setChannelMembers] = useState<Record<string, string[]>>({});
  const [presenceByUser, setPresenceByUser] = useState<Record<string, PresenceState>>({});

  const [status, setStatus] = useState("connecting");
  const [notice, setNotice] = useState<string>("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginEmail, setLoginEmail] = useState("alex@bridge.local");
  const [loginPassword, setLoginPassword] = useState("bridge123!");
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "done">("idle");
  const [activeChannelId, setActiveChannelId] = useState("c-general");
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [currentUserId, setCurrentUserId] = useState("u-1");
  const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(null);
  const [currentPresence, setCurrentPresence] = useState<PresenceState>("online");

  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelDesc, setNewChannelDesc] = useState("");
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);

  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("member");
  const [botUsers, setBotUsers] = useState<BotManagementEntry[]>([]);
  const [botDisplayName, setBotDisplayName] = useState("");
  const [botEmail, setBotEmail] = useState("");
  const [botRole, setBotRole] = useState<UserRole>("member");
  const [botTokenReveal, setBotTokenReveal] = useState<BotTokenReveal | null>(null);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const [selectedDmUserIds, setSelectedDmUserIds] = useState<string[]>([]);
  const [membershipChannelId, setMembershipChannelId] = useState("");
  const [membershipUserId, setMembershipUserId] = useState("");

  const [workspaceName, setWorkspaceName] = useState("");
  const [retentionDays, setRetentionDays] = useState(365);
  const [allowGuests, setAllowGuests] = useState(false);
  const [enforceMfa, setEnforceMfa] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);
  const lastReadMessageRef = useRef<Record<string, string>>({});
  const typingSentRef = useRef<Record<string, boolean>>({});
  const previousActiveChannelIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentUser = useMemo(
    () => users.find((user) => user.id === currentUserId) ?? null,
    [users, currentUserId]
  );
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "manager";

  const visibleChannels = useMemo(
    () => channels.filter((channel) => !channel.archivedAt),
    [channels]
  );

  const workspaceChannels = useMemo(
    () => visibleChannels.filter((channel) => channel.kind === "channel"),
    [visibleChannels]
  );

  const directConversations = useMemo(
    () => visibleChannels.filter((channel) => channel.kind === "dm" || channel.kind === "group_dm"),
    [visibleChannels]
  );

  const privateWorkspaceChannels = useMemo(
    () =>
      visibleChannels.filter(
        (channel) => channel.kind === "channel" && channel.isPrivate && !channel.archivedAt
      ),
    [visibleChannels]
  );

  const selectableDmUsers = useMemo(
    () => users.filter((user) => user.id !== currentUserId && user.isActive),
    [users, currentUserId]
  );

  const selectedMembershipChannel = useMemo(
    () =>
      privateWorkspaceChannels.find((channel) => channel.id === membershipChannelId) ??
      privateWorkspaceChannels[0] ??
      null,
    [privateWorkspaceChannels, membershipChannelId]
  );

  const selectedMembershipIds = useMemo(
    () => (selectedMembershipChannel ? channelMembers[selectedMembershipChannel.id] ?? [] : []),
    [selectedMembershipChannel, channelMembers]
  );

  const availableMembershipUsers = useMemo(
    () =>
      users.filter(
        (user) =>
          user.isActive &&
          (!selectedMembershipChannel || !selectedMembershipIds.includes(user.id))
      ),
    [users, selectedMembershipIds, selectedMembershipChannel]
  );

  const activeChannel = useMemo(
    () => visibleChannels.find((channel) => channel.id === activeChannelId) ?? visibleChannels[0] ?? null,
    [visibleChannels, activeChannelId]
  );

  const channelMessages = useMemo(
    () => messages.filter((message) => message.channelId === activeChannel?.id),
    [messages, activeChannel?.id]
  );

  const rootMessages = useMemo(
    () => channelMessages.filter((message) => !message.threadRootMessageId),
    [channelMessages]
  );

  const activeThreadRoot = useMemo(
    () => rootMessages.find((message) => message.id === activeThreadRootId) ?? null,
    [rootMessages, activeThreadRootId]
  );

  const threadMessages = useMemo(
    () =>
      activeThreadRoot
        ? channelMessages.filter((message) => message.threadRootMessageId === activeThreadRoot.id)
        : [],
    [channelMessages, activeThreadRoot]
  );

  const threadReplyCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const message of channelMessages) {
      if (message.threadRootMessageId) {
        counts[message.threadRootMessageId] = (counts[message.threadRootMessageId] ?? 0) + 1;
      }
    }
    return counts;
  }, [channelMessages]);

  const activeTypingUserIds = useMemo(
    () => (activeChannel ? (typingByChannel[activeChannel.id] ?? []).filter((id) => id !== currentUserId) : []),
    [typingByChannel, activeChannel, currentUserId]
  );

  const composerPendingAttachments = useMemo(
    () =>
      pendingAttachments.filter(
        (attachment) =>
          activeChannel &&
          attachment.channelId === activeChannel.id &&
          (attachment.threadRootMessageId ?? null) === (activeThreadRoot?.id ?? null)
      ),
    [pendingAttachments, activeChannel, activeThreadRoot]
  );

  const adminStats = useMemo(() => {
    return {
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.isActive).length,
      onlineUsers: onlineUserIds.length,
      totalChannels: visibleChannels.length,
      privateChannels: visibleChannels.filter((channel) => channel.isPrivate).length,
      totalMessages: messages.length
    };
  }, [users, onlineUserIds, visibleChannels, messages]);

  const rosterUsers = useMemo(() => {
    const order: Record<PresenceState, number> = { online: 0, away: 1, offline: 2 };
    return [...users]
      .filter((user) => user.isActive)
      .sort((left, right) => {
        const presenceDiff =
          order[presenceByUser[left.id] ?? "offline"] - order[presenceByUser[right.id] ?? "offline"];
        if (presenceDiff !== 0) {
          return presenceDiff;
        }
        return left.displayName.localeCompare(right.displayName);
      });
  }, [users, presenceByUser]);

  async function loadUnreadCounts() {
    const response = await fetch(`${apiBase}/me/unread`, { credentials: "include" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as UnreadPayload;
    setTotalUnread(payload.totalUnread);
    setUnreadCounts(
      Object.fromEntries(payload.channels.map((entry) => [entry.channelId, entry.unreadCount]))
    );
  }

  async function loadBootstrap() {
    const response = await fetch(`${apiBase}/bootstrap`, { credentials: "include" });
    if (!response.ok) {
      throw new Error("bootstrap request failed");
    }
    const payload = (await response.json()) as BootstrapPayload;
    setUsers(payload.users);
    setChannels(payload.channels);
    setMessages(payload.messages);
    setOnlineUserIds(payload.onlineUserIds);
    setWorkspace(payload.workspace);
    setPresenceByUser(buildPresenceSnapshot(payload.users, payload.onlineUserIds));
    setWorkspaceName(payload.workspace.settings.workspaceName);
    setRetentionDays(payload.workspace.settings.messageRetentionDays);
    setAllowGuests(payload.workspace.settings.allowGuestAccess);
    setEnforceMfa(payload.workspace.settings.enforceMfaForAdmins);
    await loadUnreadCounts();
  }

  async function loadAdminOverview() {
    const response = await fetch(`${apiBase}/admin/overview`, {
      credentials: "include"
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as AdminOverview;
    setAuditLog(payload.auditLog);
    setWorkspace(payload.workspace);
    setChannelMembers(payload.channelMembers);
    setWorkspaceName(payload.workspace.settings.workspaceName);
    setRetentionDays(payload.workspace.settings.messageRetentionDays);
    setAllowGuests(payload.workspace.settings.allowGuestAccess);
    setEnforceMfa(payload.workspace.settings.enforceMfaForAdmins);
  }

  async function loadBotManagement() {
    const response = await fetch(`${apiBase}/admin/bots`, {
      credentials: "include"
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as BotManagementPayload;
    setBotUsers(payload.bots);
  }

  async function loadCurrentUser() {
    const response = await fetch(`${apiBase}/auth/me`, {
      credentials: "include"
    });
    if (!response.ok) {
      setIsAuthenticated(false);
      return null;
    }
    const payload = (await response.json()) as MePayload;
    setCurrentUserId(payload.user.id);
    setIsAuthenticated(true);
    return payload.user;
  }

  function emitSocketEvent(event: ClientEvent) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(event));
  }

  function emitTyping(channelId: string, isTyping: boolean) {
    emitSocketEvent({
      type: "typing:update",
      payload: { channelId, isTyping }
    });
    typingSentRef.current[channelId] = isTyping;
  }

  function updatePresence(state: PresenceState) {
    setCurrentPresence(state);
    setPresenceByUser((current) => ({ ...current, [currentUserId]: state }));
    emitSocketEvent({
      type: "presence:update",
      payload: { state }
    });
  }

  function markChannelRead(channelId: string, messageId: string) {
    if (lastReadMessageRef.current[channelId] === messageId) {
      return;
    }
    emitSocketEvent({
      type: "read:update",
      payload: { channelId, lastMessageId: messageId }
    });
    lastReadMessageRef.current[channelId] = messageId;
    setUnreadCounts((current) => ({ ...current, [channelId]: 0 }));
    loadUnreadCounts().catch(() => undefined);
  }

  async function login() {
    const response = await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword })
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({ message: "Login failed." }))) as {
        message?: string;
      };
      setNotice(body.message ?? "Login failed. Please verify email and password.");
      return;
    }
    await loadCurrentUser();
    await loadBootstrap();
    setNotice("");
  }

  async function logout() {
    if (activeChannel && typingSentRef.current[activeChannel.id]) {
      emitTyping(activeChannel.id, false);
    }
    await fetch(`${apiBase}/auth/logout`, {
      method: "POST",
      credentials: "include"
    });
    setIsAuthenticated(false);
    setStatus("offline");
    setUnreadCounts({});
    setTotalUnread(0);
    setTypingByChannel({});
    setActiveThreadRootId(null);
    setPendingAttachments([]);
    setUploadingCount(0);
    setBotUsers([]);
    setBotTokenReveal(null);
    socketRef.current?.close();
    socketRef.current = null;
  }

  useEffect(() => {
    loadCurrentUser()
      .then((user) => {
        if (!user) {
          setStatus("auth required");
          return;
        }
        return loadBootstrap().then(() => setStatus("online"));
      })
      .catch(() => setStatus("api unavailable"));
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("online");
      updatePresence(currentPresence);
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data as string) as ServerEvent;

      if (payload.type === "sync:snapshot") {
        setUsers(payload.payload.users);
        setChannels(payload.payload.channels);
        setMessages(payload.payload.messages);
        setOnlineUserIds(payload.payload.onlineUserIds);
        setWorkspace(payload.payload.workspace);
        setPresenceByUser(buildPresenceSnapshot(payload.payload.users, payload.payload.onlineUserIds));
        loadUnreadCounts().catch(() => undefined);
      }

      if (payload.type === "message:new") {
        setMessages((current) => [...current, payload.payload]);
        if (payload.payload.senderId !== currentUserId) {
          setUnreadCounts((current) => ({
            ...current,
            [payload.payload.channelId]: (current[payload.payload.channelId] ?? 0) + 1
          }));
          setTotalUnread((current) => current + 1);
        }
      }

      if (payload.type === "message:deleted") {
        setMessages((current) =>
          current.filter((message) => message.id !== payload.payload.messageId)
        );
      }

      if (payload.type === "channel:created") {
        setChannels((current) => [...current, payload.payload]);
      }

      if (payload.type === "channel:updated") {
        setChannels((current) =>
          current.map((channel) =>
            channel.id === payload.payload.id ? payload.payload : channel
          )
        );
      }

      if (payload.type === "user:updated") {
        setUsers((current) => {
          const exists = current.some((user) => user.id === payload.payload.id);
          if (!exists) {
            return [...current, payload.payload];
          }
          return current.map((user) =>
            user.id === payload.payload.id ? payload.payload : user
          );
        });
      }

      if (payload.type === "workspace:updated") {
        setWorkspace(payload.payload);
      }

      if (payload.type === "audit:new") {
        setAuditLog((current) => [payload.payload, ...current].slice(0, 100));
      }

      if (payload.type === "presence:changed") {
        setOnlineUserIds((current) => {
          const set = new Set(current);
          if (payload.payload.state === "online") {
            set.add(payload.payload.userId);
          } else {
            set.delete(payload.payload.userId);
          }
          return [...set];
        });
        setPresenceByUser((current) => ({ ...current, [payload.payload.userId]: payload.payload.state }));
        if (payload.payload.userId === currentUserId) {
          setCurrentPresence(payload.payload.state);
        }
      }

      if (payload.type === "typing:changed") {
        setTypingByChannel((current) => {
          const currentChannel = new Set(current[payload.payload.channelId] ?? []);
          if (payload.payload.isTyping) {
            currentChannel.add(payload.payload.userId);
          } else {
            currentChannel.delete(payload.payload.userId);
          }
          return { ...current, [payload.payload.channelId]: [...currentChannel] };
        });
      }

      if (payload.type === "read:changed" && payload.payload.userId === currentUserId) {
        lastReadMessageRef.current[payload.payload.channelId] = payload.payload.lastMessageId;
        setUnreadCounts((current) => ({ ...current, [payload.payload.channelId]: 0 }));
        loadUnreadCounts().catch(() => undefined);
      }

      if (payload.type === "error") {
        setNotice(payload.payload.message);
      }
    };

    socket.onclose = () => setStatus("offline");

    return () => {
      if (activeChannel && typingSentRef.current[activeChannel.id]) {
        emitTyping(activeChannel.id, false);
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "presence:update",
            payload: { state: "offline" }
          } satisfies ClientEvent)
        );
      }
      socket.close();
      socketRef.current = null;
    };
  }, [isAuthenticated, currentUserId]);

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.settings.workspaceName);
      setRetentionDays(workspace.settings.messageRetentionDays);
      setAllowGuests(workspace.settings.allowGuestAccess);
      setEnforceMfa(workspace.settings.enforceMfaForAdmins);
    }
  }, [workspace]);

  useEffect(() => {
    setCurrentPresence(presenceByUser[currentUserId] ?? "online");
  }, [presenceByUser, currentUserId]);

  useEffect(() => {
    if (!visibleChannels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannelId(visibleChannels[0]?.id ?? "");
    }
  }, [visibleChannels, activeChannelId]);

  useEffect(() => {
    if (!privateWorkspaceChannels.some((channel) => channel.id === membershipChannelId)) {
      setMembershipChannelId(privateWorkspaceChannels[0]?.id ?? "");
      setMembershipUserId("");
    }
  }, [privateWorkspaceChannels, membershipChannelId]);

  useEffect(() => {
    setActiveThreadRootId(null);
  }, [activeChannelId]);

  useEffect(() => {
    loadAdminOverview().catch(() => {
      // no-op for non-admin users
    });
    loadBotManagement().catch(() => {
      // no-op for non-admin users
    });
  }, [currentUserId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", activeTab);
    window.history.replaceState({}, "", url.toString());
  }, [activeTab]);

  useEffect(() => {
    const previousChannelId = previousActiveChannelIdRef.current;
    if (previousChannelId && previousChannelId !== activeChannelId && typingSentRef.current[previousChannelId]) {
      emitTyping(previousChannelId, false);
    }
    previousActiveChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  useEffect(() => {
    if (!isAuthenticated || !activeChannel) {
      return;
    }
    const shouldBeTyping = draft.trim().length > 0;
    const sentTyping = typingSentRef.current[activeChannel.id] ?? false;
    if (shouldBeTyping !== sentTyping) {
      emitTyping(activeChannel.id, shouldBeTyping);
    }
  }, [draft, activeChannel, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !activeChannel || channelMessages.length === 0) {
      return;
    }
    const latestMessage = channelMessages[channelMessages.length - 1];
    const timer = window.setTimeout(() => {
      markChannelRead(activeChannel.id, latestMessage.id);
    }, 160);
    return () => window.clearTimeout(timer);
  }, [channelMessages, activeChannel, isAuthenticated]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rootMessages.length, activeChannelId]);

  async function adminRequest(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({ message: "request failed" }))) as {
        message?: string;
      };
      throw new Error(body.message ?? "request failed");
    }
    return response;
  }

  async function createNewChannel() {
    if (!newChannelName || !newChannelDesc) {
      setNotice("Please provide a channel name and description.");
      return;
    }

    try {
      await adminRequest("/admin/channels", {
        method: "POST",
        body: JSON.stringify({
          name: newChannelName.trim().toLowerCase(),
          description: newChannelDesc.trim(),
          isPrivate: newChannelPrivate
        })
      });
      setNewChannelName("");
      setNewChannelDesc("");
      setNewChannelPrivate(false);
      setNotice("Channel created.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function createConversation() {
    if (selectedDmUserIds.length === 0) {
      setNotice("Choose at least one teammate to start a direct conversation.");
      return;
    }

    try {
      const response = await fetch(`${apiBase}/dm/conversations`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          participantUserIds: selectedDmUserIds
        })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({ message: "request failed" }))) as {
          message?: string;
        };
        throw new Error(body.message ?? "request failed");
      }

      const payload = (await response.json()) as CreateConversationResponse;
      setDmPickerOpen(false);
      setSelectedDmUserIds([]);
      setActiveChannelId(payload.conversation.id);
      setActiveTab("chat");
      setNotice(
        payload.conversation.kind === "dm" ? "Direct message ready." : "Group conversation ready."
      );
      await loadBootstrap();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  function toggleDmParticipant(userId: string) {
    setSelectedDmUserIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    );
  }

  async function addPrivateChannelMember() {
    if (!selectedMembershipChannel) {
      setNotice("Create a private channel first.");
      return;
    }
    if (!membershipUserId) {
      setNotice("Choose a user to grant access.");
      return;
    }

    try {
      const response = await adminRequest(`/admin/channels/${selectedMembershipChannel.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: membershipUserId })
      });
      const payload = (await response.json()) as { channelId: string; members: string[] };
      setChannelMembers((current) => ({ ...current, [payload.channelId]: payload.members }));
      setMembershipUserId("");
      setNotice("Private channel access granted.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function removePrivateChannelMember(channelId: string, userId: string) {
    try {
      const response = await adminRequest(`/admin/channels/${channelId}/members/${userId}`, {
        method: "DELETE"
      });
      const payload = (await response.json()) as { channelId: string; members: string[] };
      setChannelMembers((current) => ({ ...current, [payload.channelId]: payload.members }));
      setNotice("Private channel access removed.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function runSearch(queryOverride?: string) {
    const query = (queryOverride ?? searchQuery).trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchStatus("idle");
      return;
    }

    setSearchStatus("loading");
    try {
      const response = await fetch(
        `${apiBase}/search/messages?q=${encodeURIComponent(query)}&limit=12`,
        { credentials: "include" }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({ message: "search failed" }))) as {
          message?: string;
        };
        throw new Error(body.message ?? "search failed");
      }

      const payload = (await response.json()) as SearchPayload;
      setSearchResults(payload.results);
      setSearchStatus("done");
    } catch (error) {
      setSearchStatus("idle");
      setNotice((error as Error).message);
    }
  }

  function jumpToSearchResult(result: SearchResult) {
    setActiveChannelId(result.channelId);
    setActiveTab("chat");
    setActiveThreadRootId(result.threadRootMessageId ?? null);
    setSearchQuery(result.content);
    setSearchResults([]);
    setSearchStatus("idle");
  }

  async function archiveExistingChannel(channelId: string) {
    try {
      await adminRequest(`/admin/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true })
      });
      setNotice("Channel archived.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function inviteNewUser() {
    if (!inviteName || !inviteEmail) {
      setNotice("Please provide a name and email for the invite.");
      return;
    }

    try {
      await adminRequest("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          displayName: inviteName.trim(),
          email: inviteEmail.trim(),
          role: inviteRole
        })
      });
      setInviteName("");
      setInviteEmail("");
      setInviteRole("member");
      setNotice("User invited.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function createBotUser() {
    if (!botDisplayName.trim()) {
      setNotice("Please provide a display name for the bot.");
      return;
    }

    try {
      const response = await adminRequest("/admin/bots", {
        method: "POST",
        body: JSON.stringify({
          displayName: botDisplayName.trim(),
          email: botEmail.trim() || undefined,
          role: botRole
        })
      });
      const payload = (await response.json()) as BotManagementResponse;
      setBotDisplayName("");
      setBotEmail("");
      setBotRole("member");
      setBotTokenReveal({
        botId: payload.bot.id,
        botName: payload.bot.displayName,
        action: "created",
        token: payload.token
      });
      setNotice("Bot created. Copy the token now.");
      await loadBotManagement();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function rotateBotToken(botId: string) {
    try {
      const response = await adminRequest(`/admin/bots/${botId}/token`, {
        method: "POST"
      });
      const payload = (await response.json()) as BotManagementResponse;
      setBotTokenReveal({
        botId: payload.bot.id,
        botName: payload.bot.displayName,
        action: "rotated",
        token: payload.token
      });
      setNotice("Bot token rotated. Copy the new token now.");
      await loadBotManagement();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function revokeBotToken(botId: string) {
    try {
      const response = await adminRequest(`/admin/bots/${botId}/token`, {
        method: "DELETE"
      });
      const payload = (await response.json()) as BotTokenRevocationResponse;
      if (botTokenReveal?.botId === botId) {
        setBotTokenReveal(null);
      }
      setNotice(
        payload.revokedTokenCount > 0
          ? "Bot token revoked."
          : "Bot had no active tokens to revoke."
      );
      await loadBotManagement();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function changeRole(userId: string, role: UserRole) {
    try {
      await adminRequest(`/admin/users/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      setNotice("Role updated.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function toggleUserStatus(userId: string, isActive: boolean) {
    try {
      await adminRequest(`/admin/users/${userId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive })
      });
      setNotice(`User ${isActive ? "activated" : "deactivated"}.`);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function saveWorkspaceSettings() {
    try {
      await adminRequest("/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          workspaceName: workspaceName.trim(),
          messageRetentionDays: retentionDays,
          allowGuestAccess: allowGuests,
          enforceMfaForAdmins: enforceMfa
        })
      });
      setNotice("Workspace settings saved.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function moderateDeleteMessage(messageId: string) {
    try {
      await adminRequest(`/admin/messages/${messageId}`, {
        method: "DELETE"
      });
      setNotice("Message deleted.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function uploadComposerFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !activeChannel) {
      return;
    }
    const files = Array.from(fileList);
    setUploadingCount((current) => current + files.length);

    for (const file of files) {
      const tempId = crypto.randomUUID();
      const optimistic: PendingAttachment = {
        id: tempId,
        channelId: activeChannel.id,
        uploaderId: currentUserId,
        threadRootMessageId: activeThreadRoot?.id,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "pending",
        createdAt: new Date().toISOString(),
        uploadState: "uploading"
      };
      setPendingAttachments((current) => [...current, optimistic]);

      try {
        const form = new FormData();
        form.append("file", file);
        form.append("channelId", activeChannel.id);
        if (activeThreadRoot?.id) {
          form.append("threadRootMessageId", activeThreadRoot.id);
        }
        const response = await fetch(`${apiBase}/attachments`, {
          method: "POST",
          credentials: "include",
          body: form
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({ message: "upload failed" }))) as {
            message?: string;
          };
          throw new Error(body.message ?? "upload failed");
        }
        const payload = (await response.json()) as UploadAttachmentResponse;
        setPendingAttachments((current) =>
          current.map((attachment) =>
            attachment.id === tempId
              ? { ...payload.attachment, uploadState: "ready" as const }
              : attachment
          )
        );
      } catch (error) {
        setPendingAttachments((current) =>
          current.map((attachment) =>
            attachment.id === tempId
              ? {
                  ...attachment,
                  uploadState: "error" as const,
                  errorMessage: (error as Error).message
                }
              : attachment
          )
        );
      } finally {
        setUploadingCount((current) => Math.max(0, current - 1));
      }
    }
  }

  async function removePendingAttachment(attachment: PendingAttachment) {
    if (attachment.uploadState !== "ready") {
      setPendingAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
      return;
    }
    try {
      const response = await fetch(`${apiBase}/attachments/${attachment.id}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({ message: "remove failed" }))) as {
          message?: string;
        };
        throw new Error(body.message ?? "remove failed");
      }
      setPendingAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  function submitMessage() {
    const content = draft.trim();
    const readyAttachmentIds = composerPendingAttachments
      .filter((attachment) => attachment.uploadState === "ready")
      .map((attachment) => attachment.id);
    if ((!content && readyAttachmentIds.length === 0) || !activeChannel) {
      return;
    }

    emitTyping(activeChannel.id, false);
    emitSocketEvent({
      type: "message:send",
      payload: {
        channelId: activeChannel.id,
        content,
        tempId: crypto.randomUUID(),
        threadRootMessageId: activeThreadRoot?.id,
        attachmentIds: readyAttachmentIds
      }
    });
    setDraft("");
    setPendingAttachments((current) =>
      current.filter(
        (attachment) =>
          !(
            attachment.channelId === activeChannel.id &&
            (attachment.threadRootMessageId ?? null) === (activeThreadRoot?.id ?? null) &&
            attachment.uploadState === "ready"
          )
      )
    );
  }

  // ─── Login Screen ───

  if (!isAuthenticated) {
    return (
      <main className="loginPage">
        <div className="loginCard">
          <div className="loginBrand">
            <div className="loginLogo">B</div>
            <h1>Bridge</h1>
            <p>Privacy-first team messaging</p>
          </div>

          <form
            className="loginForm"
            onSubmit={(event) => {
              event.preventDefault();
              login().catch(() => setNotice("Login failed."));
            }}
          >
            <label className="loginField">
              <span>Email</span>
              <input
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="you@company.com"
                type="email"
                autoComplete="email"
              />
            </label>
            <label className="loginField">
              <span>Password</span>
              <input
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                type="password"
                placeholder="Enter your password"
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="loginSubmit">Sign In</button>
          </form>
          {notice ? <p className="loginNotice">{notice}</p> : null}
          <p className="loginFooter">Secure, self-hosted workspace communication</p>
        </div>
      </main>
    );
  }

  // ─── Main App ───

  return (
    <main className="layout">
      <aside className="sidebar">
        <div className="workspaceHead">
          <h1>{workspace?.settings.workspaceName ?? "Bridge Workspace"}</h1>
          <p>Secure collaboration for companies</p>
        </div>

        <div className="userBar">
          <div className="userBarLeft">
            <div className={`presenceDot ${currentPresence}`} />
            <strong>{currentUser?.displayName ?? "You"}</strong>
          </div>
          <select
            className="presenceSelect"
            value={currentPresence}
            onChange={(event) => updatePresence(event.target.value as PresenceState)}
          >
            <option value="online">Online</option>
            <option value="away">Away</option>
            <option value="offline">Invisible</option>
          </select>
        </div>

        <div className="tabRow">
          <button
            className={`tabButton ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
            {totalUnread > 0 ? <span className="tabBadge">{totalUnread}</span> : null}
          </button>
          <button
            className={`tabButton ${activeTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveTab("admin")}
          >
            Admin
          </button>
        </div>

        <section className="navSection">
          <h3>Channels</h3>
          {workspaceChannels.map((channel) => (
            <button
              key={channel.id}
              className={`channel ${activeChannel?.id === channel.id ? "active" : ""}`}
              onClick={() => {
                setActiveChannelId(channel.id);
                setActiveTab("chat");
              }}
            >
              <span className="channelLabel">
                <span className="channelHash">#</span>
                {channel.name}
              </span>
              <span className="channelMeta">
                {channel.isPrivate ? <span className="channelPrivacy">private</span> : null}
                {(unreadCounts[channel.id] ?? 0) > 0 ? (
                  <span className="unreadBadge">{unreadCounts[channel.id]}</span>
                ) : null}
              </span>
            </button>
          ))}
        </section>

        <section className="navSection">
          <div className="sectionHead">
            <h3>Direct Messages</h3>
            <button className="miniButton" onClick={() => setDmPickerOpen((current) => !current)}>
              {dmPickerOpen ? "Cancel" : "+ New"}
            </button>
          </div>

          {dmPickerOpen ? (
            <div className="dmComposerCard">
              <p>Select one teammate for a DM or several for a group conversation.</p>
              <div className="dmUserList">
                {selectableDmUsers.map((user) => (
                  <label className="dmUserOption" key={user.id}>
                    <input
                      type="checkbox"
                      checked={selectedDmUserIds.includes(user.id)}
                      onChange={() => toggleDmParticipant(user.id)}
                    />
                    <span>{user.displayName}</span>
                  </label>
                ))}
              </div>
              <button onClick={() => createConversation().catch(() => setNotice("Conversation failed."))}>
                Start Conversation
              </button>
            </div>
          ) : null}

          {directConversations.length === 0 ? (
            <div className="emptySidebarState">No direct conversations yet.</div>
          ) : (
            directConversations.map((channel) => (
              <button
                key={channel.id}
                className={`channel ${activeChannel?.id === channel.id ? "active" : ""}`}
                onClick={() => {
                  setActiveChannelId(channel.id);
                  setActiveTab("chat");
                }}
              >
                <span className="channelLabel">{channelTitle(channel, users, currentUserId)}</span>
                <span className="channelMeta">
                  {(unreadCounts[channel.id] ?? 0) > 0 ? (
                    <span className="unreadBadge">{unreadCounts[channel.id]}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </section>

        <section className="navSection">
          <h3>People &middot; {onlineUserIds.length} online</h3>
          <div className="rosterList">
            {rosterUsers.map((user) => {
              const presence = presenceByUser[user.id] ?? "offline";
              return (
                <div className="rosterRow" key={user.id}>
                  <div className={`presenceDot ${presence}`} />
                  <div className="rosterBody">
                    <strong>
                      {user.displayName}
                      {user.id === currentUserId ? <span className="youTag">(you)</span> : null}
                    </strong>
                    <span>{user.role}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="sidebarFooter">
          <button className="logoutButton" onClick={() => logout().catch(() => setNotice("Logout failed."))}>
            Sign Out
          </button>
        </div>
      </aside>

      {activeTab === "chat" ? (
        <section className={`chat chatLayout ${activeThreadRoot ? "threadOpen" : ""}`}>
          <div className="chatMain">
            <header className="chatHeader">
              <div className="chatHeaderMain">
                <div className="chatHeaderTitle">
                  <h2>{channelTitle(activeChannel, users, currentUserId)}</h2>
                  <span className="headerOnline">{onlineUserIds.length} online</span>
                </div>
                <p className="chatHeaderDesc">{activeChannel?.description ?? "No channel selected"}</p>
              </div>
              <form
                className="searchBar"
                onSubmit={(event) => {
                  event.preventDefault();
                  runSearch().catch(() => setNotice("Search failed."));
                }}
              >
                <input
                  value={searchQuery}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setSearchQuery(nextValue);
                    if (nextValue.trim().length < 2) {
                      setSearchResults([]);
                      setSearchStatus("idle");
                    }
                  }}
                  placeholder="Search messages..."
                />
                <button type="submit">Search</button>
              </form>
            </header>

            {searchStatus !== "idle" || searchResults.length > 0 ? (
              <section className="searchPanel">
                <div className="searchPanelHead">
                  <strong>Search Results</strong>
                  <span>
                    {searchStatus === "loading"
                      ? "Searching..."
                      : `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                {searchStatus === "done" && searchResults.length === 0 ? (
                  <div className="emptySearchState">No visible messages matched that query.</div>
                ) : null}
                {searchResults.map((result) => (
                  <button
                    key={result.id}
                    className="searchResult"
                    onClick={() => jumpToSearchResult(result)}
                  >
                    <div className="searchResultTop">
                      <strong>{result.senderDisplayName}</strong>
                      <span>
                        {result.channelId === activeChannel?.id
                          ? channelTitle(activeChannel, users, currentUserId)
                          : result.channelName.startsWith("dm-") || result.channelName.startsWith("group-")
                            ? channelTitle(
                                channels.find((channel) => channel.id === result.channelId) ?? null,
                                users,
                                currentUserId
                              )
                            : `#${result.channelName}`}
                      </span>
                    </div>
                    <p>{result.content}</p>
                  </button>
                ))}
              </section>
            ) : null}

            <div className="messages">
              {rootMessages.length === 0 ? (
                <div className="emptyChat">
                  <div className="emptyChatIcon">
                    <span>#</span>
                  </div>
                  <h3>No messages yet</h3>
                  <p>Be the first to send a message in {channelTitle(activeChannel, users, currentUserId)}</p>
                </div>
              ) : (
                rootMessages.map((message) => {
                  const sender = users.find((user) => user.id === message.senderId);
                  const mentionsCurrentUser = message.mentionUserIds?.includes(currentUserId) ?? false;
                  const replyCount = threadReplyCount[message.id] ?? 0;
                  return (
                    <article
                      key={message.id}
                      className={`messageCard ${mentionsCurrentUser ? "mentioned" : ""} ${
                        activeThreadRoot?.id === message.id ? "selected" : ""
                      }`}
                    >
                      <div className="avatar">{sender?.displayName.slice(0, 2).toUpperCase() ?? "??"}</div>
                      <div className="messageBody">
                        <div className="messageTopRow">
                          <div>
                            <strong>{sender?.displayName ?? message.senderId}</strong>
                            <time className="metaTime" title={new Date(message.createdAt).toLocaleString()}>
                              {relativeTime(message.createdAt)}
                            </time>
                          </div>
                        </div>
                        {mentionsCurrentUser ? <span className="inlinePill">Mentioned you</span> : null}
                        {message.content ? <p>{renderMessageContent(message.content)}</p> : null}
                        {message.attachments && message.attachments.length > 0 ? (
                          <div className="attachmentList">
                            {message.attachments.map((attachment) => (
                              <a
                                key={attachment.id}
                                className="attachmentCard"
                                href={attachmentDownloadUrl(attachment.id)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {canInlineImage(attachment.mimeType) ? (
                                  <img
                                    src={attachmentDownloadUrl(attachment.id)}
                                    alt={attachment.originalName}
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="attachmentIcon">FILE</span>
                                )}
                                <span className="attachmentName">{attachment.originalName}</span>
                                <span className="attachmentMeta">
                                  {attachment.mimeType} · {formatAttachmentSize(attachment.sizeBytes)}
                                </span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                        {replyCount > 0 || !message.threadRootMessageId ? (
                          <button
                            className="threadButton"
                            onClick={() => setActiveThreadRootId(message.id)}
                          >
                            {replyCount > 0
                              ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
                              : "Reply in thread"}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="chatFooter">
              {activeTypingUserIds.length > 0 ? (
                <div className="typingBar">
                  <span className="typingDots" />
                  {formatTypingLabel(activeTypingUserIds, users)}
                </div>
              ) : null}

              {activeThreadRoot ? (
                <div className="threadContext">
                  Replying to thread by{" "}
                  {users.find((user) => user.id === activeThreadRoot.senderId)?.displayName ?? "teammate"}
                  <button className="threadContextClose" onClick={() => setActiveThreadRootId(null)}>
                    &times;
                  </button>
                </div>
              ) : null}

              {composerPendingAttachments.length > 0 ? (
                <div className="composerAttachments">
                  {composerPendingAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className={`pendingAttachment ${attachment.uploadState === "error" ? "error" : ""}`}
                    >
                      <div className="pendingAttachmentMain">
                        <strong>{attachment.originalName}</strong>
                        <span>
                          {formatAttachmentSize(attachment.sizeBytes)} ·{" "}
                          {attachment.uploadState === "uploading"
                            ? "uploading"
                            : attachment.uploadState === "ready"
                              ? "ready"
                              : attachment.errorMessage ?? "failed"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="ghostButton"
                        onClick={() => removePendingAttachment(attachment)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitMessage();
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="fileInputHidden"
                  onChange={(event) => {
                    uploadComposerFiles(event.target.files).catch((error) =>
                      setNotice((error as Error).message)
                    );
                    event.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  className="attachButton"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!activeChannel}
                  title="Add attachment"
                >
                  +
                </button>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={`Message ${channelTitle(activeChannel, users, currentUserId)}`}
                />
                <button type="submit" disabled={uploadingCount > 0}>
                  {uploadingCount > 0
                    ? "Uploading..."
                    : activeThreadRoot
                      ? "Reply"
                      : "Send"}
                </button>
              </form>
            </div>

            {notice ? <p className="notice">{notice}</p> : null}
          </div>

          {activeThreadRoot ? (
            <aside className="threadPanel">
              <div className="threadPanelHead">
                <div>
                  <h3>Thread</h3>
                  <p>
                    {threadMessages.length} {threadMessages.length === 1 ? "reply" : "replies"}
                  </p>
                </div>
                <button className="ghostButton" onClick={() => setActiveThreadRootId(null)}>
                  Close
                </button>
              </div>

              <div
                className={`threadRootCard ${activeThreadRoot.mentionUserIds?.includes(currentUserId) ? "mentioned" : ""}`}
              >
                <div className="threadRootMeta">
                  <strong>
                    {users.find((user) => user.id === activeThreadRoot.senderId)?.displayName ??
                      activeThreadRoot.senderId}
                  </strong>
                  <time className="metaTime" title={new Date(activeThreadRoot.createdAt).toLocaleString()}>
                    {relativeTime(activeThreadRoot.createdAt)}
                  </time>
                </div>
                {activeThreadRoot.content ? <p>{renderMessageContent(activeThreadRoot.content)}</p> : null}
                {activeThreadRoot.attachments && activeThreadRoot.attachments.length > 0 ? (
                  <div className="attachmentList">
                    {activeThreadRoot.attachments.map((attachment) => (
                      <a
                        key={attachment.id}
                        className="attachmentCard"
                        href={attachmentDownloadUrl(attachment.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {canInlineImage(attachment.mimeType) ? (
                          <img
                            src={attachmentDownloadUrl(attachment.id)}
                            alt={attachment.originalName}
                            loading="lazy"
                          />
                        ) : (
                          <span className="attachmentIcon">FILE</span>
                        )}
                        <span className="attachmentName">{attachment.originalName}</span>
                        <span className="attachmentMeta">
                          {attachment.mimeType} · {formatAttachmentSize(attachment.sizeBytes)}
                        </span>
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="threadMessages">
                {threadMessages.length === 0 ? (
                  <div className="emptyThread">No replies yet. Start the conversation.</div>
                ) : (
                  threadMessages.map((message) => {
                    const sender = users.find((user) => user.id === message.senderId);
                    const mentionsCurrentUser = message.mentionUserIds?.includes(currentUserId) ?? false;
                    return (
                      <article
                        key={message.id}
                        className={`threadMessage ${mentionsCurrentUser ? "mentioned" : ""}`}
                      >
                        <div className="threadRootMeta">
                          <strong>{sender?.displayName ?? message.senderId}</strong>
                          <time className="metaTime" title={new Date(message.createdAt).toLocaleString()}>
                            {relativeTime(message.createdAt)}
                          </time>
                        </div>
                        {mentionsCurrentUser ? <span className="inlinePill">Mentioned you</span> : null}
                        {message.content ? <p>{renderMessageContent(message.content)}</p> : null}
                        {message.attachments && message.attachments.length > 0 ? (
                          <div className="attachmentList">
                            {message.attachments.map((attachment) => (
                              <a
                                key={attachment.id}
                                className="attachmentCard"
                                href={attachmentDownloadUrl(attachment.id)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {canInlineImage(attachment.mimeType) ? (
                                  <img
                                    src={attachmentDownloadUrl(attachment.id)}
                                    alt={attachment.originalName}
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="attachmentIcon">FILE</span>
                                )}
                                <span className="attachmentName">{attachment.originalName}</span>
                                <span className="attachmentMeta">
                                  {attachment.mimeType} · {formatAttachmentSize(attachment.sizeBytes)}
                                </span>
                              </a>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>
            </aside>
          ) : null}
        </section>
      ) : (
        <section className="adminPanel">
          <header className="adminHeader">
            <div>
              <h2>Admin Board</h2>
              <p>Governance, onboarding, moderation and workspace controls.</p>
            </div>
          </header>

          {!isAdmin ? (
            <div className="card warnCard">
              Your current user does not have admin or manager permissions.
            </div>
          ) : (
            <>
              <section className="statsGrid">
                <article className="card statCard">
                  <span>Total Users</span>
                  <strong>{adminStats.totalUsers}</strong>
                </article>
                <article className="card statCard">
                  <span>Online Now</span>
                  <strong>{adminStats.onlineUsers}</strong>
                  <div className="statBar">
                    <div
                      className="statBarFill"
                      style={{
                        width: `${adminStats.totalUsers > 0 ? (adminStats.onlineUsers / adminStats.totalUsers) * 100 : 0}%`
                      }}
                    />
                  </div>
                </article>
                <article className="card statCard">
                  <span>Channels</span>
                  <strong>{adminStats.totalChannels}</strong>
                </article>
                <article className="card statCard">
                  <span>Messages</span>
                  <strong>{adminStats.totalMessages}</strong>
                </article>
              </section>

              <section className="adminGrid">
                <article className="card">
                  <h3>Create Channel</h3>
                  <input
                    value={newChannelName}
                    onChange={(event) => setNewChannelName(event.target.value)}
                    placeholder="channel-name"
                  />
                  <input
                    value={newChannelDesc}
                    onChange={(event) => setNewChannelDesc(event.target.value)}
                    placeholder="Channel description"
                  />
                  <label className="checkboxRow">
                    <input
                      type="checkbox"
                      checked={newChannelPrivate}
                      onChange={(event) => setNewChannelPrivate(event.target.checked)}
                    />
                    Private channel
                  </label>
                  <button onClick={createNewChannel}>Create</button>
                </article>

                <article className="card">
                  <h3>Invite User</h3>
                  <input
                    value={inviteName}
                    onChange={(event) => setInviteName(event.target.value)}
                    placeholder="Display name"
                  />
                  <input
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="email@company.com"
                  />
                  <select
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as UserRole)}
                  >
                    {roleOrder.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button onClick={inviteNewUser}>Invite</button>
                </article>

                <article className="card">
                  <h3>Workspace Settings</h3>
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder="Workspace name"
                  />
                  <label className="fieldLabel" htmlFor="retention">
                    Retention Days
                  </label>
                  <input
                    id="retention"
                    type="number"
                    min={7}
                    max={3650}
                    value={retentionDays}
                    onChange={(event) => setRetentionDays(Number(event.target.value || 365))}
                  />
                  <label className="checkboxRow">
                    <input
                      type="checkbox"
                      checked={allowGuests}
                      onChange={(event) => setAllowGuests(event.target.checked)}
                    />
                    Allow guest users
                  </label>
                  <label className="checkboxRow">
                    <input
                      type="checkbox"
                      checked={enforceMfa}
                      onChange={(event) => setEnforceMfa(event.target.checked)}
                    />
                    Require MFA for admins
                  </label>
                  <button onClick={saveWorkspaceSettings}>Save Settings</button>
                </article>
              </section>

              <section className="adminGrid wideGrid">
                <article className="card">
                  <h3>Bot Management</h3>
                  <input
                    value={botDisplayName}
                    onChange={(event) => setBotDisplayName(event.target.value)}
                    placeholder="Bot display name"
                  />
                  <input
                    value={botEmail}
                    onChange={(event) => setBotEmail(event.target.value)}
                    placeholder="bot@company.com (optional)"
                  />
                  <select value={botRole} onChange={(event) => setBotRole(event.target.value as UserRole)}>
                    {roleOrder.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button onClick={createBotUser}>Create Bot</button>

                  {botTokenReveal ? (
                    <div className="botTokenReveal">
                      <div className="botTokenRevealHead">
                        <strong>
                          {botTokenReveal.botName} token {botTokenReveal.action === "created" ? "created" : "rotated"}
                        </strong>
                        <span>Shown once only</span>
                      </div>
                      <textarea
                        readOnly
                        value={botTokenReveal.token}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </div>
                  ) : (
                    <p>New bot tokens are shown once after creation or rotation.</p>
                  )}
                </article>

                <article className="card">
                  <h3>Existing Bots</h3>
                  <div className="tableList botList">
                    {botUsers.length === 0 ? (
                      <div className="tableRow botEmptyState">
                        <div>
                          <strong>No bot users yet</strong>
                          <p>Create a bot to provision an API token and message automation.</p>
                        </div>
                      </div>
                    ) : (
                      botUsers.map((bot) => (
                        <div className="tableRow botRow" key={bot.id}>
                          <div className="botRowMain">
                            <strong>{bot.displayName}</strong>
                            <p>{bot.email}</p>
                            <div className="botMetaRow">
                              <span className={`pill ${bot.isActive ? "ok" : "muted"}`}>
                                {bot.isActive ? "active" : "inactive"}
                              </span>
                              <span className="botMeta">{bot.role}</span>
                              <span className="botMeta">{bot.activeTokenCount} active token{bot.activeTokenCount === 1 ? "" : "s"}</span>
                              <span className="botMeta">
                                {bot.lastTokenCreatedAt
                                  ? `last token ${relativeTime(bot.lastTokenCreatedAt)}`
                                  : "no active token"}
                              </span>
                            </div>
                          </div>
                          <div className="rowActions botActions">
                            <button onClick={() => rotateBotToken(bot.id)}>Rotate</button>
                            <button className="warnBtn" onClick={() => revokeBotToken(bot.id)}>
                              Revoke
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </article>
              </section>

              <section className="adminGrid wideGrid">
                <article className="card">
                  <h3>User Roles</h3>
                  <div className="tableList">
                    {users.map((user) => (
                      <div className="tableRow" key={user.id}>
                        <div>
                          <strong>{user.displayName}</strong>
                          <p>{user.email}</p>
                          <span className={`pill ${user.isActive ? "ok" : "muted"}`}>
                            {user.isActive ? "active" : "inactive"}
                          </span>
                        </div>
                        <div className="rowActions">
                          <select
                            value={user.role}
                            onChange={(event) =>
                              changeRole(user.id, event.target.value as UserRole)
                            }
                          >
                            {roleOrder.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => toggleUserStatus(user.id, !user.isActive)}
                            className={user.isActive ? "warnBtn" : "successBtn"}
                          >
                            {user.isActive ? "Deactivate" : "Activate"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="card">
                  <h3>Channel Lifecycle</h3>
                  <div className="tableList">
                    {visibleChannels.map((channel) => (
                      <div className="tableRow" key={channel.id}>
                        <div>
                          <strong>{channelTitle(channel, users, currentUserId)}</strong>
                          <p>{channel.description}</p>
                        </div>
                        <button onClick={() => archiveExistingChannel(channel.id)}>
                          Archive
                        </button>
                      </div>
                    ))}
                  </div>
                </article>
              </section>

              <section className="adminGrid wideGrid">
                <article className="card">
                  <h3>Private Channel Access</h3>
                  {privateWorkspaceChannels.length === 0 ? (
                    <p>No private channels exist yet.</p>
                  ) : (
                    <>
                      <label className="fieldLabel" htmlFor="membership-channel">
                        Private Channel
                      </label>
                      <select
                        id="membership-channel"
                        value={selectedMembershipChannel?.id ?? ""}
                        onChange={(event) => {
                          setMembershipChannelId(event.target.value);
                          setMembershipUserId("");
                        }}
                      >
                        {privateWorkspaceChannels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channelTitle(channel, users, currentUserId)}
                          </option>
                        ))}
                      </select>

                      <label className="fieldLabel" htmlFor="membership-user">
                        Grant Access
                      </label>
                      <div className="inlineControlRow">
                        <select
                          id="membership-user"
                          value={membershipUserId}
                          onChange={(event) => setMembershipUserId(event.target.value)}
                        >
                          <option value="">Choose a user</option>
                          {availableMembershipUsers.map((user) => (
                            <option key={user.id} value={user.id}>
                              {user.displayName} ({user.role})
                            </option>
                          ))}
                        </select>
                        <button onClick={() => addPrivateChannelMember().catch(() => setNotice("Access update failed."))}>
                          Add
                        </button>
                      </div>

                      <div className="tableList">
                        {selectedMembershipIds.length === 0 ? (
                          <div className="tableRow">
                            <div>
                              <strong>No explicit members</strong>
                              <p>Add teammates to grant private channel access.</p>
                            </div>
                          </div>
                        ) : (
                          selectedMembershipIds.map((memberId) => {
                            const member = users.find((user) => user.id === memberId);
                            return (
                              <div className="tableRow" key={memberId}>
                                <div>
                                  <strong>{member?.displayName ?? memberId}</strong>
                                  <p>{member?.email ?? "Unknown user"}</p>
                                </div>
                                <button
                                  className="warnBtn"
                                  onClick={() =>
                                    removePrivateChannelMember(
                                      selectedMembershipChannel?.id ?? "",
                                      memberId
                                    ).catch(() => setNotice("Access update failed."))
                                  }
                                >
                                  Remove
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}
                </article>

                <article className="card">
                  <h3>Access Notes</h3>
                  <p>Private workspace channels only appear to explicit members plus admin and manager users.</p>
                  <p>Direct messages are managed automatically by their conversation participants.</p>
                  <p>Membership changes take effect immediately in bootstrap, unread counts, and search visibility.</p>
                </article>
              </section>

              <section className="adminGrid wideGrid">
                <article className="card">
                  <h3>Message Moderation</h3>
                  <div className="tableList">
                    {messages.slice(-20).reverse().map((message) => {
                      const sender = users.find((u) => u.id === message.senderId);
                      return (
                        <div className="tableRow" key={message.id}>
                          <div>
                            <strong>{sender?.displayName ?? message.senderId}</strong>
                            <p>{message.content}</p>
                          </div>
                          <button onClick={() => moderateDeleteMessage(message.id)}>
                            Delete
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </article>

                <article className="card">
                  <h3>Audit Log</h3>
                  <div className="tableList auditList">
                    {auditLog.slice(0, 25).map((entry) => (
                      <div className="tableRow" key={entry.id}>
                        <div>
                          <strong>{entry.action}</strong>
                          <p>{entry.summary}</p>
                        </div>
                        <span>{relativeTime(entry.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              </section>
            </>
          )}

          {notice ? <p className="notice">{notice}</p> : null}
        </section>
      )}
    </main>
  );
}
