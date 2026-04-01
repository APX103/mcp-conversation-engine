import { useState, useRef, useEffect, useCallback } from "react";

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
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    const userMsg: Message = { role: "user", content: text };
    const assistantMsg: Message = { role: "assistant", content: "", toolCalls: [], loading: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
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

  return (
    <div style={styles.container}>
      {/* CSS keyframes for spinner */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      <header style={styles.header}>
        <h1 style={styles.headerTitle}>MCP Conversation Engine</h1>
      </header>

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
            <div style={msg.role === "user" ? styles.userBubble : styles.assistantContent}>
              {msg.role === "assistant" && msg.reasoning && <ReasoningBlock content={msg.reasoning} />}
              {msg.content && <div style={styles.textBlock}>{msg.content}</div>}
              {msg.toolCalls?.map((tc, j) => (
                <ToolCallBlock key={tc.id || j} tc={tc} />
              ))}
              {msg.loading && !msg.content && !msg.toolCalls?.length && (
                <span style={styles.typing}><Spinner /> thinking...</span>
              )}
            </div>
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
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    fontFamily: "'Inter', 'SF Pro Text', system-ui, -apple-system, sans-serif",
    background: "#ffffff",
    color: "#1a1a1a",
  },

  // Header
  header: {
    padding: "10px 20px",
    borderBottom: "1px solid #e5e5e5",
    background: "#fafafa",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#333",
    margin: 0,
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
  assistantContent: {
    maxWidth: "80%",
    display: "flex",
    flexDirection: "column",
    gap: 6,
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
};
