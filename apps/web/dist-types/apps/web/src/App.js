import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";
export function App() {
    const [messages, setMessages] = useState([]);
    const [draft, setDraft] = useState("");
    const [status, setStatus] = useState("connecting");
    const socketRef = useRef(null);
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
            socket.send(JSON.stringify({
                type: "presence:update",
                payload: { state: "online" }
            }));
        };
        socket.onmessage = (event) => {
            const payload = JSON.parse(event.data);
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
                socket.send(JSON.stringify({
                    type: "presence:update",
                    payload: { state: "offline" }
                }));
            }
            socket.close();
            socketRef.current = null;
        };
    }, []);
    const channelMessages = useMemo(() => messages.filter((m) => m.channelId === "c-general"), [messages]);
    function submitMessage() {
        const content = draft.trim();
        if (!content)
            return;
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return;
        socket.send(JSON.stringify({
            type: "message:send",
            payload: {
                channelId: "c-general",
                content,
                tempId: crypto.randomUUID()
            }
        }));
        setDraft("");
    }
    return (_jsxs("main", { className: "layout", children: [_jsxs("aside", { className: "sidebar", children: [_jsx("h1", { children: "Bridge" }), _jsx("p", { className: "sub", children: "Private team messaging" }), _jsxs("div", { className: "pill", children: ["Status: ", status] }), _jsx("button", { className: "channel active", children: "# general" }), _jsx("button", { className: "channel", children: "# product" })] }), _jsxs("section", { className: "chat", children: [_jsxs("header", { className: "chatHeader", children: [_jsx("h2", { children: "# general" }), _jsx("p", { children: "Realtime sync enabled" })] }), _jsx("div", { className: "messages", children: channelMessages.map((msg) => (_jsxs("article", { className: "message", children: [_jsx("strong", { children: msg.senderId }), _jsx("p", { children: msg.content })] }, msg.id))) }), _jsxs("form", { className: "composer", onSubmit: (event) => {
                            event.preventDefault();
                            submitMessage();
                        }, children: [_jsx("input", { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: "Message #general" }), _jsx("button", { type: "submit", children: "Send" })] })] })] }));
}
//# sourceMappingURL=App.js.map