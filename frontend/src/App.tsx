import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Types ──

interface StreamEvent {
  type: "reasoning" | "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "tool_result" | "error" | "done";
  content?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  arguments_delta?: string;
  result?: string;
}

interface ToolCallItem {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  running: boolean;
  argumentsDelta?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallItem[];
  loading?: boolean;
}

interface Session {
  sessionId: string;
  userId: string;
  title: string;
  updatedAt: number;
}

// ── Helpers ──

/** Strip "mcp__servername__" prefix for cleaner display */
function displayName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

/** Get a short label from tool arguments for inline preview */
function argPreview(args: Record<string, unknown>): string {
  for (const key of ["query", "search_query", "url", "path", "name", "question"]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      return val.length > 60 ? val.slice(0, 60) + "..." : val;
    }
  }
  return "";
}

/** Format timestamp to readable string */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  if (isToday) return `${h}:${m}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
}

// ── Components ──

// ── Markdown Renderer ──

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ── Components ──

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
    >
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolCallBlock({ tc }: { tc: ToolCallItem }) {
  const [open, setOpen] = useState(false);
  const shortName = displayName(tc.name);
  const preview = argPreview(tc.arguments);
  const isRunning = tc.running;
  const isStreaming = !!tc.argumentsDelta;

  // During streaming, show the raw delta JSON
  const displayArgs = isStreaming
    ? tc.argumentsDelta!
    : JSON.stringify(tc.arguments, null, 2);

  return (
    <div style={styles.toolBlock}>
      {/* Main row — always visible */}
      <div style={styles.toolRow} onClick={() => setOpen(!open)}>
        {isRunning ? (
          <span style={{ color: "#007bff" }}><Spinner /></span>
        ) : (
          <span style={{ color: "#16a34a" }}><CheckIcon /></span>
        )}
        <ChevronIcon open={open} />
        <span style={styles.toolLabel}>
          <span style={styles.toolNameText}>{shortName}</span>
          {isStreaming ? (
            <span style={styles.toolRunning}>receiving args...</span>
          ) : preview && !isRunning ? (
            <span style={styles.toolPreview}>{preview}</span>
          ) : null}
          {!isStreaming && isRunning && <span style={styles.toolRunning}>running...</span>}
        </span>
      </div>

      {/* Expandable details */}
      {open && (
        <div style={styles.toolDetails}>
          {/* Arguments */}
          <div style={styles.detailSection}>
            <div style={styles.detailLabel}>Arguments</div>
            <pre style={styles.codeBlock}>{displayArgs}</pre>
          </div>

          {/* Result */}
          {tc.result && !isRunning && (
            <div style={styles.detailSection}>
              <div style={styles.detailLabel}>Result</div>
              <pre style={styles.codeBlock}>{tc.result}</pre>
            </div>
          )}

          {/* Running indicator */}
          {isRunning && !isStreaming && (
            <div style={{ ...styles.detailSection, color: "#666", fontStyle: "italic" }}>
              Waiting for result...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={styles.reasoningBlock}>
      <div style={styles.reasoningRow} onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} />
        <span style={styles.reasoningLabel}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginRight: 4 }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
          </svg>
          Thinking
        </span>
      </div>
      {open && (
        <div style={styles.reasoningBody}>
          <pre style={styles.codeBlock}>{content}</pre>
        </div>
      )}
    </div>
  );
}

// ── Main App ──

const API_BASE = "http://localhost:3000";

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [username, setUsername] = useState<string>(() => localStorage.getItem("username") || "");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [hoveredSessionId, setHoveredSessionId] = useState<string>("");
  const [menuOpenSessionId, setMenuOpenSessionId] = useState<string>("");
  const [editingSessionId, setEditingSessionId] = useState<string>("");
  const [renameInput, setRenameInput] = useState("");
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(true);
  const [reasoningEffort, setReasoningEffort] = useState<"high" | "max">("high");
  const [loginInput, setLoginInput] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load sessions and thinking config after login
  useEffect(() => {
    if (!username) return;
    loadSessions(username);
    fetch(`${API_BASE}/api/config/thinking`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.thinking === "boolean") setThinkingEnabled(data.thinking);
        if (data.reasoningEffort) setReasoningEffort(data.reasoningEffort);
      })
      .catch(() => {});
  }, [username]);

  const loadSessions = async (userId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions?userId=${encodeURIComponent(userId)}`);
      const data = await res.json();
      const list: Session[] = (data.sessions || []).map((s: any) => ({
        sessionId: s.sessionId,
        userId: s.userId,
        title: s.title || "New Chat",
        updatedAt: s.updatedAt ? new Date(s.updatedAt).getTime() : Date.now(),
      }));
      setSessions(list);
      if (list.length > 0) {
        // Switch to the most recently updated session
        await switchSession(list[0].sessionId);
      } else {
        // Auto-create first session
        await createSession(userId);
      }
    } catch {
      // ignore
    }
  };

  const createSession = async (userId: string, title?: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, title }),
      });
      const data = await res.json();
      const newSession: Session = {
        sessionId: data.sessionId,
        userId: data.userId,
        title: data.title,
        updatedAt: Date.now(),
      };
      setSessions((prev) => [newSession, ...prev]);
      await switchSession(data.sessionId);
    } catch {
      // ignore
    }
  };

  const switchSession = async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      const history = convertHistory(data.messages || []);
      setMessages(history);
    } catch {
      setMessages([]);
    }
  };

  const handleLogin = async () => {
    const name = loginInput.trim();
    if (!name) {
      setLoginError("请输入用户名");
      return;
    }
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || "登录失败");
        return;
      }
      localStorage.setItem("username", data.user.username);
      setUsername(data.user.username);
    } catch (err: any) {
      setLoginError("网络错误，请重试");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("username");
    setUsername("");
    setSessions([]);
    setCurrentSessionId("");
    setHoveredSessionId("");
    setMenuOpenSessionId("");
    setEditingSessionId("");
    setRenameInput("");
    setThinkingEnabled(true);
    setReasoningEffort("high");
    setMessages([]);
  };

  const toggleThinking = async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(next);
    try {
      await fetch(`${API_BASE}/api/config/thinking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinking: next }),
      });
    } catch {
      // ignore
    }
  };

  const switchEffort = async (value: "high" | "max") => {
    setReasoningEffort(value);
    try {
      await fetch(`${API_BASE}/api/config/thinking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningEffort: value }),
      });
    } catch {
      // ignore
    }
  };

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, title: trimmed } : s))
      );
    } catch {
      // ignore
    }
    setEditingSessionId("");
    setRenameInput("");
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!window.confirm("确定删除这个对话吗？")) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      setMenuOpenSessionId("");
      if (currentSessionId === sessionId) {
        setCurrentSessionId("");
        setMessages([]);
        // Switch to another session if available
        const remaining = sessions.filter((s) => s.sessionId !== sessionId);
        if (remaining.length > 0) {
          await switchSession(remaining[0].sessionId);
        } else if (username) {
          await createSession(username);
        }
      }
    } catch {
      // ignore
    }
  };

  // Convert backend ChatMessage[] to frontend Message[]
  function convertHistory(serverMessages: any[]): Message[] {
    const result: Message[] = [];
    for (let i = 0; i < serverMessages.length; i++) {
      const m = serverMessages[i];
      if (m.role === "user") {
        result.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const toolCalls: ToolCallItem[] = (m.tool_calls || []).map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
          result: "",
          running: false,
        }));
        let j = i + 1;
        while (j < serverMessages.length && serverMessages[j].role === "tool") {
          const toolMsg = serverMessages[j];
          const tc = toolCalls.find((t) => t.id === toolMsg.tool_call_id);
          if (tc) tc.result = toolMsg.content;
          j++;
        }
        result.push({
          role: "assistant",
          content: m.content,
          reasoning: m.reasoning_content,
          toolCalls,
        });
      }
    }
    return result;
  }

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    // Auto-rename session on first message
    if (messages.length === 0) {
      const title = text.length > 20 ? text.slice(0, 20) + "..." : text;
      fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).catch(() => {});
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === currentSessionId ? { ...s, title } : s))
      );
    }

    const userMsg: Message = { role: "user", content: text };
    const assistantMsg: Message = { role: "assistant", content: "", toolCalls: [], loading: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: currentSessionId }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6);
          if (!json) continue;

          const event: StreamEvent = JSON.parse(json);

          setMessages((prev) => {
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            // Deep copy toolCalls so React detects the change
            last.toolCalls = last.toolCalls ? [...last.toolCalls.map((tc) => ({ ...tc }))] : [];
            updated[updated.length - 1] = last;

            switch (event.type) {
              case "reasoning":
                last.reasoning = (last.reasoning ?? "") + (event.content ?? "");
                break;
              case "text":
                last.content += event.content ?? "";
                break;
              case "tool_call_start":
                last.toolCalls = last.toolCalls ?? [];
                last.toolCalls.push({
                  id: event.id ?? "",
                  name: event.name ?? "",
                  arguments: event.arguments ?? {},
                  result: "",
                  running: true,
                  argumentsDelta: "",
                });
                break;
              case "tool_call_delta": {
                if (last.toolCalls) {
                  const idx = last.toolCalls.findIndex((t) => t.id === event.id);
                  if (idx >= 0) {
                    last.toolCalls[idx] = {
                      ...last.toolCalls[idx],
                      argumentsDelta: (last.toolCalls[idx] as any).argumentsDelta + (event.arguments_delta ?? ""),
                    };
                  }
                }
                break;
              }
              case "tool_call_end": {
                if (last.toolCalls) {
                  const idx = last.toolCalls.findIndex((t) => t.id === event.id);
                  if (idx >= 0) {
                    last.toolCalls[idx] = {
                      ...last.toolCalls[idx],
                      arguments: event.arguments ?? {},
                      argumentsDelta: undefined,
                    };
                  }
                }
                break;
              }
              case "tool_result": {
                if (last.toolCalls) {
                  const idx = last.toolCalls.findIndex((t) => t.id === event.id);
                  if (idx >= 0) {
                    last.toolCalls[idx] = {
                      ...last.toolCalls[idx],
                      result: event.result ?? "",
                      running: false,
                    };
                  }
                }
                break;
              }
              case "error":
                last.content += `\n\nError: ${event.content}`;
                break;
            }
            return updated;
          });
        }
      }
    } catch (err: any) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = { ...updated[updated.length - 1] };
        last.content = `Connection error: ${err.message}`;
        updated[updated.length - 1] = last;
        return updated;
      });
    }

    setMessages((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], loading: false };
      return updated;
    });
    setSending(false);
  };

  // 未登录 — 显示登录页
  if (!username) {
    return (
      <div style={styles.loginContainer}>
        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
        <div style={styles.loginCard}>
          <div style={styles.loginIcon}>MCP</div>
          <h2 style={styles.loginTitle}>欢迎</h2>
          <p style={styles.loginSubtitle}>输入用户名即可开始使用</p>
          <input
            style={styles.loginInput}
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="用户名"
            disabled={loginLoading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleLogin();
              }
            }}
          />
          {loginError && <div style={styles.loginError}>{loginError}</div>}
          <button
            style={{
              ...styles.loginButton,
              opacity: loginLoading || !loginInput.trim() ? 0.6 : 1,
            }}
            onClick={handleLogin}
            disabled={loginLoading || !loginInput.trim()}
          >
            {loginLoading ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
                <Spinner /> 登录中...
              </span>
            ) : (
              "进入"
            )}
          </button>
        </div>
      </div>
    );
  }

  // 已登录 — 显示侧边栏 + 聊天界面
  return (
    <div style={styles.layout}>
      {/* CSS keyframes + Markdown styles */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .markdown-body { font-size: 14px; line-height: 1.6; color: #1a1a1a; }
        .markdown-body h1 { font-size: 18px; font-weight: 700; margin: 12px 0 6px; }
        .markdown-body h2 { font-size: 16px; font-weight: 600; margin: 10px 0 5px; }
        .markdown-body h3 { font-size: 15px; font-weight: 600; margin: 8px 0 4px; }
        .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 14px; font-weight: 600; margin: 6px 0 3px; }
        .markdown-body p { margin: 0 0 8px; }
        .markdown-body p:last-child { margin-bottom: 0; }
        .markdown-body strong { font-weight: 600; }
        .markdown-body em { font-style: italic; }
        .markdown-body ul, .markdown-body ol { margin: 4px 0; padding-left: 20px; }
        .markdown-body li { margin: 2px 0; }
        .markdown-body li > p { margin: 0; }
        .markdown-body a { color: #007bff; text-decoration: none; }
        .markdown-body a:hover { text-decoration: underline; }
        .markdown-body table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
        .markdown-body th, .markdown-body td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
        .markdown-body th { background: #f8f8f8; font-weight: 600; }
        .markdown-body tr:nth-child(even) { background: #fafafa; }
        .markdown-body blockquote { margin: 8px 0; padding: 8px 12px; border-left: 3px solid #ddd; color: #666; background: #f9f9f9; border-radius: 0 4px 4px 0; }
        .markdown-body hr { border: none; border-top: 1px solid #e5e5e5; margin: 12px 0; }
        .markdown-body code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 12.5px; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
        .markdown-body pre { background: #f5f5f5; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; margin: 8px 0; border: 1px solid #eee; }
        .markdown-body pre code { background: none; padding: 0; }
        .session-item:hover { background: #f5f5f5; }
        .session-item-active { background: #f0f7ff !important; }
      `}</style>

      {/* Sidebar */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <span style={styles.sidebarTitle}>MCP Engine</span>
          <button style={styles.newChatBtn} onClick={() => createSession(username)}>
            + 新对话
          </button>
        </div>
        <div style={styles.sessionList}>
          {sessions.map((s) => {
            const showMenu = hoveredSessionId === s.sessionId || menuOpenSessionId === s.sessionId;
            const isMenuOpen = menuOpenSessionId === s.sessionId;
            return (
              <div
                key={s.sessionId}
                className={s.sessionId === currentSessionId ? "session-item session-item-active" : "session-item"}
                style={{ ...styles.sessionItem, position: "relative" }}
                onMouseEnter={() => setHoveredSessionId(s.sessionId)}
                onMouseLeave={() => setHoveredSessionId("")}
                onClick={() => switchSession(s.sessionId)}
              >
                {editingSessionId === s.sessionId ? (
                  <input
                    autoFocus
                    style={styles.sessionRenameInput}
                    value={renameInput}
                    onChange={(e) => setRenameInput(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSession(s.sessionId, renameInput);
                      if (e.key === "Escape") {
                        setEditingSessionId("");
                        setRenameInput("");
                      }
                    }}
                    onBlur={() => handleRenameSession(s.sessionId, renameInput)}
                  />
                ) : (
                  <>
                    <div style={styles.sessionTitle}>{s.title}</div>
                    <div style={styles.sessionTime}>{formatTime(s.updatedAt)}</div>
                  </>
                )}
                {showMenu && editingSessionId !== s.sessionId && (
                  <button
                    style={styles.sessionMenuBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpenSessionId(isMenuOpen ? "" : s.sessionId);
                    }}
                  >
                    ⋮
                  </button>
                )}
                {isMenuOpen && (
                  <div style={styles.sessionMenuDropdown}>
                    <button
                      style={styles.sessionMenuItem}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenSessionId("");
                        setEditingSessionId(s.sessionId);
                        setRenameInput(s.title);
                      }}
                    >
                      ✎ 重命名
                    </button>
                    <button
                      style={styles.sessionMenuDelete}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(s.sessionId);
                      }}
                    >
                      🗑 删除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={styles.thinkingControls}>
          <div style={styles.thinkingRow}>
            <span style={styles.thinkingLabel}>Thinking</span>
            <button
              style={{
                ...styles.thinkingToggle,
                background: thinkingEnabled ? "#007bff" : "#ccc",
              }}
              onClick={toggleThinking}
            >
              <span
                style={{
                  ...styles.thinkingToggleKnob,
                  transform: thinkingEnabled ? "translateX(14px)" : "translateX(0)",
                }}
              />
            </button>
          </div>
          {thinkingEnabled && (
            <div style={styles.effortRow}>
              <button
                style={{
                  ...styles.effortBtn,
                  background: reasoningEffort === "high" ? "#e6f0ff" : "transparent",
                  color: reasoningEffort === "high" ? "#007bff" : "#666",
                }}
                onClick={() => switchEffort("high")}
              >
                high
              </button>
              <button
                style={{
                  ...styles.effortBtn,
                  background: reasoningEffort === "max" ? "#e6f0ff" : "transparent",
                  color: reasoningEffort === "max" ? "#007bff" : "#666",
                }}
                onClick={() => switchEffort("max")}
              >
                max
              </button>
            </div>
          )}
        </div>
        <div style={styles.sidebarFooter}>
          <span style={styles.username}>{username}</span>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            退出
          </button>
        </div>
      </div>

      {/* Main chat area */}
      <div style={styles.main}>
        <div style={styles.messages}>
          {messages.length === 0 && (
            <div style={styles.empty}>
              <div style={styles.emptyIcon}>MCP</div>
              <div>Send a message to start a conversation.</div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={msg.role === "user" ? styles.userRow : styles.assistantRow}>
              <div style={styles.avatar}>
                {msg.role === "user" ? "You" : "AI"}
              </div>
              {msg.role === "user" ? (
                <div style={styles.userBubble}>{msg.content}</div>
              ) : (
                <div style={styles.assistantBubble}>
                  {msg.reasoning && <ReasoningBlock content={msg.reasoning} />}
                  {msg.content && <MarkdownContent content={msg.content} />}
                  {msg.toolCalls?.map((tc, j) => (
                    <ToolCallBlock key={tc.id || j} tc={tc} />
                  ))}
                  {msg.loading && !msg.content && !msg.toolCalls?.length && (
                    <span style={styles.typing}><Spinner /> thinking...</span>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <form
          style={styles.inputBar}
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button style={{ ...styles.button, opacity: sending || !input.trim() ? 0.5 : 1 }} type="submit" disabled={sending || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: "flex",
    flexDirection: "row",
    height: "100vh",
    fontFamily: "'Inter', 'SF Pro Text', system-ui, -apple-system, sans-serif",
    background: "#f7f7f8",
    color: "#1a1a1a",
  },

  // Sidebar
  sidebar: {
    width: 260,
    display: "flex",
    flexDirection: "column",
    background: "#fff",
    borderRight: "1px solid #e5e5e5",
    flexShrink: 0,
  },
  sidebarHeader: {
    padding: "14px 16px",
    borderBottom: "1px solid #e5e5e5",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sidebarTitle: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#1a1a1a",
  },
  newChatBtn: {
    padding: "5px 10px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    background: "#fff",
    color: "#333",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    whiteSpace: "nowrap",
  },
  sessionList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  sessionItem: {
    padding: "10px 12px",
    borderRadius: "8px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    transition: "background 0.15s",
  },
  sessionItemActive: {
    background: "#f0f7ff",
  },
  sessionTitle: {
    fontSize: "13px",
    fontWeight: 500,
    color: "#1a1a1a",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sessionTime: {
    fontSize: "11px",
    color: "#999",
  },
  sessionMenuBtn: {
    position: "absolute",
    top: "6px",
    right: "6px",
    padding: "2px 6px",
    borderRadius: "4px",
    border: "none",
    background: "transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    lineHeight: 1,
    zIndex: 2,
  },
  sessionRenameInput: {
    width: "100%",
    padding: "4px 6px",
    borderRadius: "4px",
    border: "1px solid #007bff",
    fontSize: "13px",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  sessionMenuDropdown: {
    position: "absolute",
    top: "28px",
    right: "6px",
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
    padding: "4px",
    zIndex: 10,
    minWidth: "100px",
  },
  sessionMenuItem: {
    width: "100%",
    padding: "6px 10px",
    borderRadius: "4px",
    border: "none",
    background: "transparent",
    color: "#333",
    cursor: "pointer",
    fontSize: "13px",
    textAlign: "left" as const,
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  sessionMenuDelete: {
    width: "100%",
    padding: "6px 10px",
    borderRadius: "4px",
    border: "none",
    background: "transparent",
    color: "#dc2626",
    cursor: "pointer",
    fontSize: "13px",
    textAlign: "left" as const,
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  thinkingControls: {
    padding: "10px 16px",
    borderTop: "1px solid #e5e5e5",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  thinkingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  thinkingLabel: {
    fontSize: "13px",
    fontWeight: 500,
    color: "#333",
  },
  thinkingToggle: {
    width: "34px",
    height: "20px",
    borderRadius: "10px",
    border: "none",
    cursor: "pointer",
    position: "relative",
    transition: "background 0.2s",
    padding: 0,
  },
  thinkingToggleKnob: {
    display: "block",
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    background: "#fff",
    transition: "transform 0.2s",
    margin: "2px",
  },
  effortRow: {
    display: "flex",
    gap: "4px",
  },
  effortBtn: {
    flex: 1,
    padding: "4px 8px",
    borderRadius: "4px",
    border: "1px solid #e5e5e5",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    transition: "all 0.15s",
  },
  sidebarFooter: {
    padding: "12px 16px",
    borderTop: "1px solid #e5e5e5",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },

  // Main chat area
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "#ffffff",
  },

  // Messages area
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  empty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#999",
    gap: 12,
    fontSize: "14px",
  },
  emptyIcon: {
    fontSize: "32px",
    fontWeight: 700,
    color: "#ccc",
    border: "2px solid #e5e5e5",
    borderRadius: "12px",
    padding: "12px 20px",
    letterSpacing: "2px",
  },

  // Message rows
  userRow: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
  },
  assistantRow: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-start",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "11px",
    fontWeight: 600,
    flexShrink: 0,
    background: "#007bff",
    color: "#fff",
  },
  userBubble: {
    background: "#007bff",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: "12px",
    maxWidth: "70%",
    fontSize: "14px",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  assistantBubble: {
    maxWidth: "80%",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: "12px",
    padding: "14px 16px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  textBlock: {
    fontSize: "14px",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  typing: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#999",
    fontStyle: "italic",
    fontSize: "13px",
  },

  // Tool call block (Claude Code style)
  toolBlock: {
    marginTop: 2,
    marginBottom: 2,
    borderRadius: "6px",
    border: "1px solid #e5e5e5",
    overflow: "hidden",
    fontSize: "13px",
  },
  toolRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 10px",
    cursor: "pointer",
    userSelect: "none",
    background: "#fafafa",
    transition: "background 0.1s",
  },
  toolLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  toolNameText: {
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontWeight: 500,
    fontSize: "12.5px",
    color: "#1a1a1a",
    flexShrink: 0,
  },
  toolPreview: {
    color: "#888",
    fontSize: "12px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  toolRunning: {
    color: "#007bff",
    fontSize: "12px",
    fontStyle: "italic",
  },
  toolDetails: {
    borderTop: "1px solid #e5e5e5",
    padding: "8px 12px",
    background: "#fff",
  },
  detailSection: {
    marginBottom: 6,
  },
  detailLabel: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    color: "#888",
    marginBottom: 4,
  },

  // Reasoning block
  reasoningBlock: {
    borderRadius: "6px",
    border: "1px solid #fde68a",
    overflow: "hidden",
    fontSize: "13px",
  },
  reasoningRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 10px",
    cursor: "pointer",
    userSelect: "none",
    background: "#fffbeb",
    transition: "background 0.1s",
  },
  reasoningLabel: {
    display: "flex",
    alignItems: "center",
    fontWeight: 500,
    fontSize: "12.5px",
    color: "#92400e",
  },
  reasoningBody: {
    borderTop: "1px solid #fde68a",
    padding: "8px 12px",
    background: "#fff",
  },

  // Code block (shared)
  codeBlock: {
    margin: 0,
    padding: "8px 10px",
    background: "#f5f5f5",
    borderRadius: "4px",
    overflow: "auto",
    maxHeight: "240px",
    fontSize: "12px",
    lineHeight: 1.5,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    border: "1px solid #eee",
  },

  // Input bar
  inputBar: {
    display: "flex",
    padding: "12px 20px",
    borderTop: "1px solid #e5e5e5",
    gap: "8px",
    background: "#fafafa",
  },
  input: {
    flex: 1,
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    fontSize: "14px",
    outline: "none",
    background: "#fff",
    fontFamily: "inherit",
    transition: "border-color 0.15s",
  },
  button: {
    padding: "10px 20px",
    borderRadius: "8px",
    border: "none",
    background: "#007bff",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "14px",
    transition: "opacity 0.15s",
  },

  // User info in header
  userInfo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginLeft: "auto",
  },
  username: {
    fontSize: "13px",
    color: "#555",
    fontWeight: 500,
  },
  logoutBtn: {
    padding: "4px 10px",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    background: "#fff",
    color: "#555",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
  },

  // Login page
  loginContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    fontFamily: "'Inter', 'SF Pro Text', system-ui, -apple-system, sans-serif",
    background: "#f7f7f8",
    color: "#1a1a1a",
  },
  loginCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    background: "#fff",
    padding: "40px 36px",
    borderRadius: "16px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.06)",
    width: "100%",
    maxWidth: "360px",
  },
  loginIcon: {
    fontSize: "28px",
    fontWeight: 700,
    color: "#007bff",
    letterSpacing: "2px",
  },
  loginTitle: {
    fontSize: "22px",
    fontWeight: 600,
    margin: 0,
    color: "#1a1a1a",
  },
  loginSubtitle: {
    fontSize: "14px",
    color: "#888",
    margin: 0,
    marginTop: -8,
  },
  loginInput: {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    fontSize: "15px",
    outline: "none",
    background: "#fff",
    fontFamily: "inherit",
    boxSizing: "border-box",
    transition: "border-color 0.15s",
  },
  loginButton: {
    width: "100%",
    padding: "12px 20px",
    borderRadius: "10px",
    border: "none",
    background: "#007bff",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "15px",
    transition: "opacity 0.15s",
  },
  loginError: {
    color: "#dc2626",
    fontSize: "13px",
    width: "100%",
    textAlign: "center" as const,
  },
};
