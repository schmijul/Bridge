import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AuditLogEntry,
  Channel,
  ClientEvent,
  Message,
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

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";

const roleOrder: UserRole[] = ["admin", "manager", "member", "guest"];

export function App() {
  const initialTab: Tab =
    new URLSearchParams(window.location.search).get("tab") === "admin" ? "admin" : "chat";
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  const [status, setStatus] = useState("connecting");
  const [notice, setNotice] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [activeChannelId, setActiveChannelId] = useState("c-general");
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [currentUserId, setCurrentUserId] = useState("u-1");

  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelDesc, setNewChannelDesc] = useState("");
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);

  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("member");

  const [workspaceName, setWorkspaceName] = useState("");
  const [retentionDays, setRetentionDays] = useState(365);
  const [allowGuests, setAllowGuests] = useState(false);
  const [enforceMfa, setEnforceMfa] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);

  const currentUser = useMemo(
    () => users.find((user) => user.id === currentUserId) ?? null,
    [users, currentUserId]
  );
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "manager";

  const visibleChannels = useMemo(
    () => channels.filter((channel) => !channel.archivedAt),
    [channels]
  );

  const activeChannel = useMemo(
    () => visibleChannels.find((channel) => channel.id === activeChannelId) ?? visibleChannels[0] ?? null,
    [visibleChannels, activeChannelId]
  );

  const channelMessages = useMemo(
    () => messages.filter((message) => message.channelId === activeChannel?.id),
    [messages, activeChannel?.id]
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

  async function loadBootstrap() {
    const response = await fetch(`${apiBase}/bootstrap`);
    if (!response.ok) {
      throw new Error("bootstrap request failed");
    }
    const payload = (await response.json()) as BootstrapPayload;
    setUsers(payload.users);
    setChannels(payload.channels);
    setMessages(payload.messages);
    setOnlineUserIds(payload.onlineUserIds);
    setWorkspace(payload.workspace);
    setWorkspaceName(payload.workspace.settings.workspaceName);
    setRetentionDays(payload.workspace.settings.messageRetentionDays);
    setAllowGuests(payload.workspace.settings.allowGuestAccess);
    setEnforceMfa(payload.workspace.settings.enforceMfaForAdmins);
  }

  async function loadAdminOverview() {
    const response = await fetch(`${apiBase}/admin/overview`, {
      headers: {
        "x-user-id": currentUserId
      }
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as AdminOverview;
    setAuditLog(payload.auditLog);
    setWorkspace(payload.workspace);
    setWorkspaceName(payload.workspace.settings.workspaceName);
    setRetentionDays(payload.workspace.settings.messageRetentionDays);
    setAllowGuests(payload.workspace.settings.allowGuestAccess);
    setEnforceMfa(payload.workspace.settings.enforceMfaForAdmins);
  }

  useEffect(() => {
    loadBootstrap()
      .then(() => setStatus("online"))
      .catch(() => setStatus("api unavailable"));

    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      setStatus("online");
      socket.send(
        JSON.stringify({
          type: "presence:update",
          payload: { state: "online" }
        } satisfies ClientEvent)
      );
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data as string) as ServerEvent;

      if (payload.type === "sync:snapshot") {
        setUsers(payload.payload.users);
        setChannels(payload.payload.channels);
        setMessages(payload.payload.messages);
        setOnlineUserIds(payload.payload.onlineUserIds);
        setWorkspace(payload.payload.workspace);
      }

      if (payload.type === "message:new") {
        setMessages((current) => [...current, payload.payload]);
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
      }

      if (payload.type === "error") {
        setNotice(payload.payload.message);
      }
    };

    socket.onclose = () => setStatus("offline");

    return () => {
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
  }, []);

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.settings.workspaceName);
      setRetentionDays(workspace.settings.messageRetentionDays);
      setAllowGuests(workspace.settings.allowGuestAccess);
      setEnforceMfa(workspace.settings.enforceMfaForAdmins);
    }
  }, [workspace]);

  useEffect(() => {
    if (!visibleChannels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannelId(visibleChannels[0]?.id ?? "");
    }
  }, [visibleChannels, activeChannelId]);

  useEffect(() => {
    loadAdminOverview().catch(() => {
      // no-op for non-admin users
    });
  }, [currentUserId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", activeTab);
    window.history.replaceState({}, "", url.toString());
  }, [activeTab]);

  async function adminRequest(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-user-id": currentUserId,
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

  function submitMessage() {
    const content = draft.trim();
    if (!content) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannel) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "message:send",
        payload: {
          channelId: activeChannel.id,
          content,
          tempId: crypto.randomUUID()
        }
      } satisfies ClientEvent)
    );
    setDraft("");
  }

  return (
    <main className="layout">
      <aside className="sidebar">
        <div className="workspaceHead">
          <h1>{workspace?.settings.workspaceName ?? "Bridge Workspace"}</h1>
          <p>Secure collaboration for companies</p>
        </div>

        <div className="statusRow">
          <span className={`statusDot ${status === "online" ? "online" : ""}`} />
          <span>{status}</span>
        </div>

        <label className="fieldLabel" htmlFor="active-user">
          Active User
        </label>
        <select
          id="active-user"
          className="selectInput"
          value={currentUserId}
          onChange={(event) => setCurrentUserId(event.target.value)}
        >
          {users
            .slice()
            .sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))
            .map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} ({user.role})
              </option>
            ))}
        </select>

        <div className="tabRow">
          <button
            className={`tabButton ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
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
          {visibleChannels.map((channel) => (
            <button
              key={channel.id}
              className={`channel ${activeChannel?.id === channel.id ? "active" : ""}`}
              onClick={() => {
                setActiveChannelId(channel.id);
                setActiveTab("chat");
              }}
            >
              #{channel.name}
              {channel.isPrivate ? " (private)" : ""}
            </button>
          ))}
        </section>
      </aside>

      {activeTab === "chat" ? (
        <section className="chat">
          <header className="chatHeader">
            <div>
              <h2>#{activeChannel?.name ?? "unknown"}</h2>
              <p>{activeChannel?.description ?? "No channel selected"}</p>
            </div>
            <div className="headerMeta">{onlineUserIds.length} online</div>
          </header>

          <div className="messages">
            {channelMessages.map((message) => {
              const sender = users.find((user) => user.id === message.senderId);
              return (
                <article key={message.id} className="message">
                  <div className="avatar">{sender?.displayName.slice(0, 2).toUpperCase() ?? "??"}</div>
                  <div className="messageBody">
                    <strong>{sender?.displayName ?? message.senderId}</strong>
                    <span className="metaTime">{new Date(message.createdAt).toLocaleString()}</span>
                    <p>{message.content}</p>
                  </div>
                </article>
              );
            })}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitMessage();
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Message #${activeChannel?.name ?? "channel"}`}
            />
            <button type="submit">Send</button>
          </form>

          {notice ? <p className="notice">{notice}</p> : null}
        </section>
      ) : (
        <section className="adminPanel">
          <header className="adminHeader">
            <h2>Admin Board</h2>
            <p>Governance, onboarding, moderation and workspace controls.</p>
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
                  <span>Online Users</span>
                  <strong>{adminStats.onlineUsers}</strong>
                </article>
                <article className="card statCard">
                  <span>Channels</span>
                  <strong>{adminStats.totalChannels}</strong>
                </article>
                <article className="card statCard">
                  <span>Total Messages</span>
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
                          <strong>#{channel.name}</strong>
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
                  <h3>Message Moderation</h3>
                  <div className="tableList">
                    {messages.slice(-20).reverse().map((message) => (
                      <div className="tableRow" key={message.id}>
                        <div>
                          <strong>{message.senderId}</strong>
                          <p>{message.content}</p>
                        </div>
                        <button onClick={() => moderateDeleteMessage(message.id)}>
                          Delete
                        </button>
                      </div>
                    ))}
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
                        <span>{new Date(entry.createdAt).toLocaleString()}</span>
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
