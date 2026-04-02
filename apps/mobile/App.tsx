import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";

import type { Channel, Message, User } from "@bridge/shared";
import {
  fetchBootstrap,
  fetchNotifications,
  fetchUnreadSummary,
  login,
  markNotificationsRead,
  MobileApiError,
  type MobileBootstrapPayload,
  type MobileNotification,
  type MobileUnreadSummary
} from "./src/api";
import { getMobileConfig } from "./src/config";

const config = getMobileConfig();
const NOTIFICATION_PAGE_SIZE = 12;

type MobileSection = "chat" | "notifications";

type MobileNotificationFeed = {
  items: MobileNotification[];
  totalCount: number;
  unreadCount: number;
};

function channelLabel(channel: Channel): string {
  if (channel.kind === "channel") {
    return `#${channel.name}`;
  }
  return channel.name;
}

function channelUnreadMap(summary: MobileUnreadSummary | null): Map<string, number> {
  return new Map((summary?.channels ?? []).map((entry) => [entry.channelId, entry.unreadCount]));
}

function formatRelativeTime(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function senderLabel(message: Message, usersById: Map<string, User>): string {
  const user = usersById.get(message.senderId);
  if (!user) {
    return message.senderId;
  }
  return user.isBot ? `${user.displayName} (bot)` : user.displayName;
}

function notificationTypeLabel(type: MobileNotification["type"]): string {
  return type === "mention" ? "Mention" : "Direct message";
}

function shortSummary(value: string | null): string {
  if (!value) {
    return "Activity on a message you follow.";
  }
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function AttachmentChips({ message }: { message: Message }) {
  if (!message.attachments?.length) {
    return null;
  }

  return (
    <View style={styles.attachmentWrap}>
      {message.attachments.map((attachment) => (
        <View key={attachment.id} style={styles.attachmentChip}>
          <Text numberOfLines={1} style={styles.attachmentName}>
            {attachment.originalName}
          </Text>
          <Text style={styles.attachmentMeta}>
            {Math.max(1, Math.ceil(attachment.sizeBytes / 1024))} KB
          </Text>
        </View>
      ))}
    </View>
  );
}

function MessageCard({
  message,
  usersById
}: {
  message: Message;
  usersById: Map<string, User>;
}) {
  return (
    <View style={styles.messageCard}>
      <View style={styles.messageHeader}>
        <Text style={styles.messageSender}>{senderLabel(message, usersById)}</Text>
        <Text style={styles.messageTime}>{formatRelativeTime(message.createdAt)}</Text>
      </View>
      {message.threadRootMessageId ? <Text style={styles.threadTag}>Thread reply</Text> : null}
      <Text style={styles.messageBody}>{message.content || "Attachment-only message"}</Text>
      <AttachmentChips message={message} />
    </View>
  );
}

function ChannelPill({
  channel,
  active,
  unreadCount,
  onPress
}: {
  channel: Channel;
  active: boolean;
  unreadCount: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.channelPill, active ? styles.channelPillActive : null]}
    >
      <View style={styles.channelPillTopRow}>
        <Text style={[styles.channelPillLabel, active ? styles.channelPillLabelActive : null]}>
          {channelLabel(channel)}
        </Text>
        {unreadCount > 0 ? (
          <View style={[styles.badge, active ? styles.badgeActive : null]}>
            <Text style={[styles.badgeText, active ? styles.badgeTextActive : null]}>{unreadCount}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.channelPillMeta, active ? styles.channelPillMetaActive : null]}>
        {channel.isPrivate ? "private" : "public"}
      </Text>
    </Pressable>
  );
}

function SectionTab({
  label,
  active,
  badge,
  onPress
}: {
  label: string;
  active: boolean;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.sectionTab, active ? styles.sectionTabActive : null]}
    >
      <Text style={[styles.sectionTabLabel, active ? styles.sectionTabLabelActive : null]}>{label}</Text>
      {typeof badge === "number" && badge > 0 ? (
        <View style={[styles.badge, active ? styles.badgeActive : null]}>
          <Text style={[styles.badgeText, active ? styles.badgeTextActive : null]}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function NotificationCard({
  notification,
  channelName
}: {
  notification: MobileNotification;
  channelName: string;
}) {
  return (
    <View style={[styles.notificationCard, notification.isUnread ? styles.notificationCardUnread : null]}>
      <View style={styles.notificationHeader}>
        <View style={styles.notificationHeaderLeft}>
          <Text style={styles.notificationType}>{notificationTypeLabel(notification.type)}</Text>
          <Text style={styles.notificationTime}>{formatRelativeTime(notification.createdAt)}</Text>
        </View>
        <View style={[styles.badge, notification.isUnread ? styles.badgeUnread : styles.badgeRead]}>
          <Text style={[styles.badgeText, notification.isUnread ? styles.badgeTextUnread : styles.badgeTextRead]}>
            {notification.isUnread ? "Unread" : "Read"}
          </Text>
        </View>
      </View>
      <Text style={styles.notificationTitle}>
        {notification.actorDisplayName}
        {notification.actorIsBot ? " (bot)" : ""} in {channelName}
      </Text>
      <Text style={styles.notificationBody}>{shortSummary(notification.messageContent)}</Text>
      <View style={styles.notificationMetaRow}>
        <Text style={styles.notificationMeta}>{notification.channelKind.replace("_", " ")}</Text>
      </View>
    </View>
  );
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<MobileBootstrapPayload | null>(null);
  const [workspaceUnread, setWorkspaceUnread] = useState<MobileUnreadSummary | null>(null);
  const [notificationFeed, setNotificationFeed] = useState<MobileNotificationFeed | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<MobileSection>("chat");
  const [checkingSession, setCheckingSession] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsMutating, setNotificationsMutating] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [signedInName, setSignedInName] = useState<string | null>(null);
  const [statusText, setStatusText] = useState(`Connecting to ${config.apiUrl}...`);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("alex@bridge.local");
  const [loginPassword, setLoginPassword] = useState("bridge123!");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const usersById = useMemo(() => {
    return new Map((bootstrap?.users ?? []).map((user) => [user.id, user]));
  }, [bootstrap?.users]);

  const visibleChannels = useMemo(() => {
    return (bootstrap?.channels ?? []).filter((channel) => !channel.archivedAt);
  }, [bootstrap?.channels]);

  const selectedChannel = useMemo(() => {
    if (!bootstrap || !selectedChannelId) {
      return null;
    }
    return visibleChannels.find((channel) => channel.id === selectedChannelId) ?? null;
  }, [bootstrap, selectedChannelId, visibleChannels]);

  const selectedMessages = useMemo(() => {
    if (!bootstrap || !selectedChannel) {
      return [];
    }
    return bootstrap.messages
      .filter((message) => message.channelId === selectedChannel.id)
      .slice()
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }, [bootstrap, selectedChannel]);

  const unreadByChannel = useMemo(() => channelUnreadMap(workspaceUnread), [workspaceUnread]);
  const workspaceUnreadCount = workspaceUnread?.totalUnread ?? 0;
  const notificationUnreadCount = notificationFeed?.unreadCount ?? 0;
  const notificationItems = notificationFeed?.items ?? [];
  function handleSessionExpired(message: string): void {
    setBootstrap(null);
    setWorkspaceUnread(null);
    setNotificationFeed(null);
    setSelectedChannelId(null);
    setActiveSection("chat");
    setStatusText("Sign in to load your workspace.");
    setSessionMessage(message);
    setNotificationError(null);
  }

  async function loadNotificationInbox(): Promise<void> {
    setNotificationsLoading(true);
    setNotificationError(null);

    try {
      const [unreadResult, notificationsResult] = await Promise.all([
        fetchUnreadSummary(config),
        fetchNotifications(config, {
          limit: NOTIFICATION_PAGE_SIZE,
          offset: 0
        })
      ]);
      setWorkspaceUnread(unreadResult);
      setNotificationFeed({
        items: notificationsResult.notifications,
        totalCount: notificationsResult.totalCount,
        unreadCount: notificationsResult.unreadCount
      });
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 401) {
        handleSessionExpired("Your session expired. Please sign in again.");
        return;
      }
      setNotificationError(error instanceof Error ? error.message : "Failed to load notifications.");
    } finally {
      setNotificationsLoading(false);
    }
  }

  async function loadWorkspace(options?: { keepSelection?: boolean }): Promise<void> {
    setRefreshing(true);
    setSessionMessage(`Loading workspace from ${config.apiUrl}...`);
    setNotificationError(null);
    try {
      const nextBootstrap = await fetchBootstrap(config);
      setBootstrap(nextBootstrap);
      setSelectedChannelId((current) => {
        if (options?.keepSelection && current && nextBootstrap.channels.some((channel) => channel.id === current)) {
          return current;
        }
        return (
          nextBootstrap.channels.find((channel) => !channel.archivedAt)?.id ?? nextBootstrap.channels[0]?.id ?? null
        );
      });
      setStatusText(`Workspace ready: ${nextBootstrap.workspace.settings.workspaceName}`);
      setSessionMessage(signedInName ? `Signed in as ${signedInName}.` : "Session restored from stored cookies.");
      await loadNotificationInbox();
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 401) {
        handleSessionExpired("Waiting for login.");
      } else {
        setSessionMessage(error instanceof Error ? error.message : "Failed to load workspace.");
      }
    } finally {
      setRefreshing(false);
      setCheckingSession(false);
    }
  }

  useEffect(() => {
    void loadWorkspace({ keepSelection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(): Promise<void> {
    setLoginBusy(true);
    setLoginError(null);
    setSessionMessage(`Signing in through ${config.apiUrl}...`);
    try {
      const response = await login(config, loginEmail.trim(), loginPassword);
      setSignedInName(response.user.displayName);
      await loadWorkspace({ keepSelection: false });
      setSessionMessage(`Welcome, ${response.user.displayName}.`);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed.");
      setSessionMessage("Login failed.");
    } finally {
      setLoginBusy(false);
    }
  }

  function handleRefresh(): void {
    void loadWorkspace({ keepSelection: true });
  }

  function handleRefreshInbox(): void {
    void loadNotificationInbox();
  }

  async function handleMarkAllNotificationsRead(): Promise<void> {
    setNotificationsMutating(true);
    setNotificationError(null);
    try {
      await markNotificationsRead(config, { all: true });
      await loadNotificationInbox();
    } catch (error) {
      if (error instanceof MobileApiError && error.status === 401) {
        handleSessionExpired("Your session expired. Please sign in again.");
        return;
      }
      setNotificationError(error instanceof Error ? error.message : "Failed to clear notification inbox.");
    } finally {
      setNotificationsMutating(false);
    }
  }

  const chatSection = (
    <View style={[styles.section, styles.messagesSection]}>
      <View style={styles.messageSectionHeader}>
        <Text style={styles.sectionLabel}>Messages</Text>
        <Text style={styles.channelDescription}>
          {selectedChannel ? selectedChannel.description || channelLabel(selectedChannel) : "Choose a channel"}
        </Text>
      </View>

      <FlatList
        data={selectedMessages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        renderItem={({ item }) => <MessageCard message={item} usersById={usersById} />}
        ListEmptyComponent={
          <View style={styles.emptyMessageState}>
            <Text style={styles.emptyTitle}>
              {selectedChannel ? "No messages in this channel yet." : "Select a channel to view messages."}
            </Text>
            <Text style={styles.emptyBody}>
              This shell already loads auth, bootstrap, unread counts, and notification inbox data so the
              remaining realtime and composer work can land later without changing the navigation structure.
            </Text>
          </View>
        }
      />
    </View>
  );

  const notificationsSection = (
    <View style={[styles.section, styles.messagesSection]}>
      <View style={styles.messageSectionHeader}>
        <Text style={styles.sectionLabel}>Notifications</Text>
        <Text style={styles.channelDescription}>
          Session-backed inbox for mentions and direct messages.
        </Text>
      </View>

      <View style={styles.notificationSummaryCard}>
        <View style={styles.statStrip}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{notificationUnreadCount}</Text>
            <Text style={styles.statLabel}>Unread notifications</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{workspaceUnreadCount}</Text>
            <Text style={styles.statLabel}>Workspace unread</Text>
          </View>
        </View>
        <Text style={styles.helperText}>
          Notifications use the current session-backed APIs. Push delivery is still an operator-side follow-up.
        </Text>
        <View style={styles.notificationActionRow}>
          <Pressable
            accessibilityRole="button"
            disabled={notificationsLoading || notificationsMutating}
            onPress={handleRefreshInbox}
            style={[styles.secondaryActionButton, notificationsLoading ? styles.secondaryActionButtonDisabled : null]}
          >
            <Text style={styles.secondaryActionButtonText}>
              {notificationsLoading ? "Refreshing..." : "Refresh inbox"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={notificationsMutating || notificationUnreadCount === 0}
            onPress={handleMarkAllNotificationsRead}
            style={[
              styles.secondaryActionButton,
              notificationUnreadCount === 0 ? styles.secondaryActionButtonDisabled : null
            ]}
          >
            <Text style={styles.secondaryActionButtonText}>Mark all read</Text>
          </Pressable>
        </View>
      </View>

      {notificationError ? <Text style={styles.errorText}>{notificationError}</Text> : null}

      {notificationsLoading && notificationItems.length === 0 ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color="#8fc9ff" />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      ) : null}

      <FlatList
        data={notificationItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        renderItem={({ item }) => {
          const channel = visibleChannels.find((entry) => entry.id === item.channelId);
          return (
            <NotificationCard
              channelName={channel ? channelLabel(channel) : item.channelName}
              notification={item}
            />
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyMessageState}>
            <Text style={styles.emptyTitle}>No notifications yet.</Text>
            <Text style={styles.emptyBody}>
              When mentions or direct messages arrive, they will show up here with read state and message context.
            </Text>
          </View>
        }
      />
    </View>
  );

  const authenticatedContent = bootstrap ? (
    <View style={styles.shell}>
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{bootstrap.workspace.settings.workspaceName}</Text>
            <Text style={styles.subtitle}>
              {signedInName ? `Signed in as ${signedInName}` : "Session connected"} - {config.apiUrl}
            </Text>
          </View>
          <Pressable onPress={handleRefresh} style={styles.refreshButton}>
            <Text style={styles.refreshButtonText}>{refreshing ? "Refreshing..." : "Refresh"}</Text>
          </Pressable>
        </View>
        <Text style={styles.statusLine}>{statusText}</Text>
        <View style={styles.statStrip}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{workspaceUnreadCount}</Text>
            <Text style={styles.statLabel}>Unread in workspace</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{notificationUnreadCount}</Text>
            <Text style={styles.statLabel}>Notifications</Text>
          </View>
        </View>
        <Text style={styles.realtimeHint}>
          Realtime socket reserved for the next shell iteration: {config.wsUrl}
        </Text>
      </View>

      <View style={styles.tabRow}>
        <SectionTab
          active={activeSection === "chat"}
          badge={workspaceUnreadCount}
          label="Chat"
          onPress={() => setActiveSection("chat")}
        />
        <SectionTab
          active={activeSection === "notifications"}
          badge={notificationUnreadCount}
          label="Inbox"
          onPress={() => setActiveSection("notifications")}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Channels</Text>
        <FlatList
          horizontal
          data={visibleChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.channelStrip}
          renderItem={({ item }) => (
            <ChannelPill
              active={item.id === selectedChannel?.id}
              channel={item}
              onPress={() => setSelectedChannelId(item.id)}
              unreadCount={unreadByChannel.get(item.id) ?? 0}
            />
          )}
          ListEmptyComponent={<Text style={styles.emptyState}>No visible channels yet.</Text>}
          showsHorizontalScrollIndicator={false}
        />
      </View>

      {activeSection === "chat" ? chatSection : null}
      {activeSection === "notifications" ? notificationsSection : null}
    </View>
  ) : (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.loginScreen}
    >
      <ScrollView contentContainerStyle={styles.loginContent} keyboardShouldPersistTaps="handled">
        <View style={styles.headerCard}>
          <Text style={styles.title}>Bridge Mobile</Text>
          <Text style={styles.subtitle}>Expo shell for the existing Bridge backend</Text>
          <Text style={styles.statusLine}>{statusText}</Text>
          <Text style={styles.realtimeHint}>API: {config.apiUrl}</Text>
          <Text style={styles.realtimeHint}>WS: {config.wsUrl}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Session Login</Text>
          <Text style={styles.helperText}>
            Uses the same `/auth/login` endpoint and stored session cookie as the web client.
          </Text>
          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>Email</Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              onChangeText={setLoginEmail}
              placeholder="alex@bridge.local"
              placeholderTextColor="#7b8796"
              style={styles.input}
              value={loginEmail}
            />
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="password"
              onChangeText={setLoginPassword}
              placeholder="bridge123!"
              placeholderTextColor="#7b8796"
              secureTextEntry
              style={styles.input}
              value={loginPassword}
            />
            {loginError ? <Text style={styles.errorText}>{loginError}</Text> : null}
            <Pressable
              accessibilityRole="button"
              disabled={loginBusy}
              onPress={handleLogin}
              style={[styles.loginButton, loginBusy ? styles.loginButtonDisabled : null]}
            >
              <Text style={styles.loginButtonText}>{loginBusy ? "Signing in..." : "Sign in"}</Text>
            </Pressable>
          </View>
        </View>

        {checkingSession ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color="#8fc9ff" />
            <Text style={styles.loadingText}>Checking for an existing session...</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      {sessionMessage ? <Text style={styles.sessionBanner}>{sessionMessage}</Text> : null}
      {authenticatedContent}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1220"
  },
  sessionBanner: {
    backgroundColor: "#10243d",
    color: "#d6e8ff",
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  loginScreen: {
    flex: 1
  },
  loginContent: {
    padding: 16,
    gap: 16
  },
  shell: {
    flex: 1,
    padding: 16,
    gap: 16
  },
  headerCard: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    gap: 10
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  title: {
    color: "#f5f7fb",
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 0.2
  },
  subtitle: {
    color: "#8d9bb0",
    fontSize: 13,
    marginTop: 4
  },
  statusLine: {
    color: "#dfe8f5",
    fontSize: 14
  },
  realtimeHint: {
    color: "#7e90a8",
    fontSize: 12
  },
  refreshButton: {
    backgroundColor: "#1d6fff",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  refreshButtonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700"
  },
  section: {
    gap: 10
  },
  messagesSection: {
    flex: 1
  },
  sectionLabel: {
    color: "#c9d7ea",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1
  },
  helperText: {
    color: "#8d9bb0",
    fontSize: 13,
    lineHeight: 18
  },
  inputCard: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    gap: 12
  },
  inputLabel: {
    color: "#c9d7ea",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8
  },
  input: {
    backgroundColor: "#0c1424",
    borderColor: "#223654",
    borderRadius: 16,
    borderWidth: 1,
    color: "#f5f7fb",
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 13
  },
  loginButton: {
    alignItems: "center",
    backgroundColor: "#2bd4aa",
    borderRadius: 18,
    paddingVertical: 14
  },
  loginButtonDisabled: {
    opacity: 0.7
  },
  loginButtonText: {
    color: "#04211a",
    fontSize: 15,
    fontWeight: "800"
  },
  errorText: {
    color: "#ff9aa6",
    fontSize: 13,
    lineHeight: 18
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    paddingVertical: 20
  },
  loadingText: {
    color: "#8d9bb0",
    fontSize: 13
  },
  tabRow: {
    flexDirection: "row",
    gap: 10
  },
  sectionTab: {
    alignItems: "center",
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12
  },
  sectionTabActive: {
    backgroundColor: "#1d6fff",
    borderColor: "#1d6fff"
  },
  sectionTabLabel: {
    color: "#dfe8f5",
    fontSize: 13,
    fontWeight: "700"
  },
  sectionTabLabelActive: {
    color: "#ffffff"
  },
  badge: {
    alignItems: "center",
    backgroundColor: "#223654",
    borderRadius: 999,
    minWidth: 26,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  badgeActive: {
    backgroundColor: "#ffffff"
  },
  badgeUnread: {
    backgroundColor: "#2bd4aa"
  },
  badgeRead: {
    backgroundColor: "#223654"
  },
  badgeText: {
    color: "#f5f7fb",
    fontSize: 11,
    fontWeight: "800"
  },
  badgeTextActive: {
    color: "#1d6fff"
  },
  badgeTextUnread: {
    color: "#04211a"
  },
  badgeTextRead: {
    color: "#dfe8f5"
  },
  channelStrip: {
    gap: 10,
    paddingVertical: 4
  },
  channelPill: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 18,
    borderWidth: 1,
    minWidth: 132,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4
  },
  channelPillActive: {
    backgroundColor: "#1d6fff",
    borderColor: "#1d6fff"
  },
  channelPillTopRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8
  },
  channelPillLabel: {
    color: "#f5f7fb",
    flex: 1,
    fontSize: 15,
    fontWeight: "700"
  },
  channelPillLabelActive: {
    color: "#ffffff"
  },
  channelPillMeta: {
    color: "#8d9bb0",
    fontSize: 11,
    textTransform: "uppercase"
  },
  channelPillMetaActive: {
    color: "#dce7ff"
  },
  messageSectionHeader: {
    gap: 4
  },
  channelDescription: {
    color: "#8d9bb0",
    fontSize: 13
  },
  messageList: {
    gap: 12,
    paddingBottom: 24
  },
  messageCard: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  messageHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  },
  messageSender: {
    color: "#f5f7fb",
    fontSize: 14,
    fontWeight: "700"
  },
  messageTime: {
    color: "#8d9bb0",
    fontSize: 12
  },
  threadTag: {
    color: "#2bd4aa",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  messageBody: {
    color: "#dfe8f5",
    fontSize: 15,
    lineHeight: 21
  },
  attachmentWrap: {
    gap: 8
  },
  attachmentChip: {
    backgroundColor: "#0c1424",
    borderColor: "#223654",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  attachmentName: {
    color: "#f5f7fb",
    fontSize: 13,
    fontWeight: "700"
  },
  attachmentMeta: {
    color: "#8d9bb0",
    fontSize: 11,
    marginTop: 2
  },
  emptyState: {
    color: "#8d9bb0",
    fontSize: 13,
    paddingVertical: 8
  },
  emptyMessageState: {
    alignItems: "center",
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 18
  },
  emptyTitle: {
    color: "#f5f7fb",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center"
  },
  emptyBody: {
    color: "#8d9bb0",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center"
  },
  notificationSummaryCard: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  statStrip: {
    flexDirection: "row",
    gap: 10
  },
  statCard: {
    backgroundColor: "#0c1424",
    borderColor: "#223654",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    gap: 2,
    padding: 12
  },
  statValue: {
    color: "#f5f7fb",
    fontSize: 20,
    fontWeight: "800"
  },
  statLabel: {
    color: "#8d9bb0",
    fontSize: 11,
    textTransform: "uppercase"
  },
  notificationActionRow: {
    flexDirection: "row",
    gap: 10
  },
  secondaryActionButton: {
    alignItems: "center",
    backgroundColor: "#0c1424",
    borderColor: "#223654",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 12
  },
  secondaryActionButtonDisabled: {
    opacity: 0.6
  },
  secondaryActionButtonText: {
    color: "#dfe8f5",
    fontSize: 13,
    fontWeight: "700"
  },
  notificationCard: {
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 14
  },
  notificationCardUnread: {
    borderColor: "#2bd4aa"
  },
  notificationHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10
  },
  notificationHeaderLeft: {
    flex: 1,
    gap: 3
  },
  notificationType: {
    color: "#f5f7fb",
    fontSize: 13,
    fontWeight: "800"
  },
  notificationTitle: {
    color: "#f5f7fb",
    fontSize: 15,
    fontWeight: "700"
  },
  notificationTime: {
    color: "#8d9bb0",
    fontSize: 12
  },
  notificationBody: {
    color: "#dfe8f5",
    fontSize: 14,
    lineHeight: 20
  },
  notificationMetaRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  },
  notificationMeta: {
    color: "#8d9bb0",
    fontSize: 11,
    textTransform: "uppercase"
  },
  inlineActionButton: {
    backgroundColor: "#1d6fff",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  inlineActionButtonDisabled: {
    opacity: 0.6
  },
  inlineActionButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700"
  },
  loadMoreButton: {
    alignItems: "center",
    backgroundColor: "#101a2e",
    borderColor: "#20314b",
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 4,
    paddingVertical: 12
  },
  loadMoreButtonDisabled: {
    opacity: 0.6
  },
  loadMoreButtonText: {
    color: "#dfe8f5",
    fontSize: 13,
    fontWeight: "700"
  },
  preferencesScroll: {
    paddingBottom: 28,
    gap: 16
  },
  preferenceSummaryTitle: {
    color: "#f5f7fb",
    fontSize: 16,
    fontWeight: "800"
  },
  preferenceSummaryGrid: {
    flexDirection: "row",
    gap: 10
  },
  preferenceStack: {
    gap: 10
  },
  preferenceRow: {
    alignItems: "center",
    backgroundColor: "#0c1424",
    borderColor: "#223654",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    padding: 12
  },
  preferenceCopy: {
    flex: 1,
    gap: 3
  },
  preferenceTitle: {
    color: "#f5f7fb",
    fontSize: 14,
    fontWeight: "700"
  },
  preferenceDescription: {
    color: "#8d9bb0",
    fontSize: 12,
    lineHeight: 17
  },
  preferenceToggle: {
    alignItems: "center",
    backgroundColor: "#20314b",
    borderRadius: 999,
    minWidth: 64,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  preferenceToggleOn: {
    backgroundColor: "#2bd4aa"
  },
  preferenceToggleBusy: {
    opacity: 0.75
  },
  preferenceToggleText: {
    color: "#dfe8f5",
    fontSize: 12,
    fontWeight: "800"
  },
  preferenceToggleTextOn: {
    color: "#04211a"
  }
});
