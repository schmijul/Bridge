import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientEvent, Message, ServerEvent } from "@bridge/shared";

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("connecting");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/bootstrap`)
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages);
      })
      .catch(() => {
        setStatus("api unavailable");
      });

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
      if (payload.type === "message:new") {
        setMessages((existing) => [...existing, payload.payload]);
      }
      if (payload.type === "sync:snapshot") {
        setMessages(payload.payload.messages);
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

  const channelMessages = useMemo(
    () => messages.filter((m) => m.channelId === "c-general"),
    [messages]
  );
  const membersOnline = status === "online" ? 2 : 0;

  function submitMessage() {
    const content = draft.trim();
    if (!content) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "message:send",
        payload: {
          channelId: "c-general",
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
          <h1>Bridge</h1>
          <p>Product Team</p>
        </div>

        <div className="statusRow">
          <span className={`statusDot ${status === "online" ? "online" : ""}`} />
          <span>{status}</span>
        </div>

        <section className="navSection">
          <h3>Channels</h3>
          <button className="channel active"># general</button>
          <button className="channel"># product</button>
          <button className="channel"># standup</button>
        </section>

        <section className="navSection">
          <h3>Direct Messages</h3>
          <button className="channel dm">Alex</button>
          <button className="channel dm">Sam</button>
        </section>
      </aside>

      <section className="chat">
        <header className="chatHeader">
          <div>
            <h2># general</h2>
            <p>Team updates and day-to-day collaboration</p>
          </div>
          <div className="headerMeta">{membersOnline} online</div>
        </header>

        <div className="messages">
          {channelMessages.map((msg) => (
            <article key={msg.id} className="message">
              <div className="avatar">{msg.senderId.replace("u-", "U")}</div>
              <div className="messageBody">
                <strong>{msg.senderId}</strong>
                <p>{msg.content}</p>
              </div>
            </article>
          ))}
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
            placeholder="Message #general"
          />
          <button type="submit">Send</button>
        </form>
      </section>
    </main>
  );
}
