import { useState, useRef, useEffect, useCallback } from "react";
import { MarkdownContent } from "./components/MarkdownContent";
import { ThinkingBlock } from "./components/ThinkingBlock";
import { ToolCallBlock } from "./components/ToolBlocks";
import { ResearchChain } from "./components/ResearchChain";
import TeamPanel from "./components/TeamPanel";
import { useTeam } from "./hooks/useTeam";
import { Spinner, BrainIcon, MemoryIcon, SendIcon, StopIcon, CloseIcon } from "./components/Icons";
import { API_BASE, formatTime } from "./lib/utils";
import type { Message, Session, StreamEvent, ResearchStreamEvent, ResearchState } from "./types";

export default function App() {
  // ── State ──
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryTab, setMemoryTab] = useState<"longTerm" | "dailyLogs" | "commitments">("longTerm");
  const [memoryMarkdown, setMemoryMarkdown] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  const [dailyLogs, setDailyLogs] = useState<Array<{ date: string; content: string }>>([]);
  const [commitments, setCommitments] = useState<Array<{ _id: string; content: string; createdAt: number }>>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryConsolidating, setMemoryConsolidating] = useState(false);
  const [skills, setSkills] = useState<Array<{ _id: string; name: string; description: string; enabled: boolean; builtin: boolean }>>([]);
  const [deepResearchMode, setDeepResearchMode] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return "dark";
  });
  const [researchState, setResearchState] = useState<ResearchState>({
    active: false, taskId: "", title: "", phase: "", detail: "",
    progress: 0, findings: [], logs: [], completed: false, error: "",
  });
  const [researchSaved, setResearchSaved] = useState(false);
  const [teamPanelOpen, setTeamPanelOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Team state
  const {
    team,
    teammates,
    tasks: teamTasks,
    messages: teamMessages,
    connected: teamConnected,
    loadTeam,
  } = useTeam();

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!username) return;
    loadSessions(username);
    loadSkills();
    fetch(`${API_BASE}/api/config/thinking`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.thinking === "boolean") setThinkingEnabled(data.thinking);
        if (data.reasoningEffort) setReasoningEffort(data.reasoningEffort);
      })
      .catch(() => {});
  }, [username]);

  // ── Session Management ──

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
        await switchSession(list[0].sessionId);
      } else {
        await createSession(userId);
      }
    } catch {}
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
    } catch {}
  };

  const switchSession = async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    // Load active team for this session
    await loadTeam(sessionId);
    setResearchState({
      active: false, taskId: "", title: "", phase: "", detail: "",
      progress: 0, findings: [], logs: [], completed: false, error: "",
    });
    setResearchSaved(false);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      if (!res.ok) {
        setMessages([]);
        return;
      }
      const data = await res.json();
      const history = convertHistory(data.messages || []);
      setMessages(history);

      try {
        const researchRes = await fetch(`${API_BASE}/api/research?sessionId=${encodeURIComponent(sessionId)}`);
        const task = await researchRes.json();
        if (task) {
          if (task.status === "completed" && task.hasReport) {
            setResearchState({
              active: true, taskId: task._id || "", title: task.query || "",
              phase: "completed", detail: "", progress: 100,
              findings: task.findings || [], logs: [], completed: true, error: "",
            });
          } else if (task.status === "failed") {
            setResearchState({
              active: true, taskId: task._id || "", title: task.query || "",
              phase: "failed", detail: "", progress: 0,
              findings: task.findings || [], logs: [], completed: false, error: task.error || "研究失败",
            });
          }
        }
      } catch {}
    } catch {
      setMessages([]);
    }
  };

  function convertHistory(serverMessages: any[]): Message[] {
    const result: Message[] = [];
    for (let i = 0; i < serverMessages.length; i++) {
      const m = serverMessages[i];
      if (m.role === "user") {
        result.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        const toolCalls = (m.tool_calls || []).map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
          result: "",
          running: false,
        }));
        let j = i + 1;
        while (j < serverMessages.length && serverMessages[j].role === "tool") {
          const toolMsg = serverMessages[j];
          const tc = toolCalls.find((t: any) => t.id === toolMsg.tool_call_id);
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

  // ── Auth ──

  const handleLogin = async () => {
    const name = loginInput.trim();
    if (!name) { setLoginError("请输入用户名"); return; }
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      const data = await res.json();
      if (!res.ok) { setLoginError(data.error || "登录失败"); return; }
      localStorage.setItem("username", data.user.username);
      setUsername(data.user.username);
    } catch { setLoginError("网络错误，请重试"); }
    finally { setLoginLoading(false); }
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
    setMemoryOpen(false);
    setMemoryMarkdown("");
    setMemoryDraft("");
    setDailyLogs([]);
    setCommitments([]);
    setSkills([]);
  };

  const handleStop = async () => {
    if (!abortControllerRef.current) return;
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    try {
      await fetch(`${API_BASE}/api/stop/${encodeURIComponent(currentSessionId)}`, { method: "POST" });
    } catch {}
    setSending(false);
  };

  // ── Skills ──

  const loadSkills = async () => {
    if (!username) return;
    try {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(username)}`);
      const data = await res.json();
      setSkills(data.skills || []);
    } catch {}
  };

  const toggleSkill = async (id: string, enabled: boolean) => {
    if (!username) return;
    try {
      await fetch(`${API_BASE}/api/skills/${encodeURIComponent(username)}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      setSkills((prev) => prev.map((s) => (s._id === id ? { ...s, enabled: !enabled } : s)));
    } catch {}
  };

  // ── Memory ──

  const loadMemory = async () => {
    if (!username) return;
    setMemoryLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(username)}`);
      const data = await res.json();
      setMemoryMarkdown(data.longTerm || "");
      setMemoryDraft(data.longTerm || "");
      setDailyLogs(data.dailyLogs || []);
      const commitRes = await fetch(`${API_BASE}/api/commitments/${encodeURIComponent(username)}`);
      const commitData = await commitRes.json();
      setCommitments(commitData.commitments || []);
    } catch {} finally { setMemoryLoading(false); }
  };

  const saveMemory = async () => {
    if (!username) return;
    setMemorySaving(true);
    try {
      await fetch(`${API_BASE}/api/memory/${encodeURIComponent(username)}/long-term`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: memoryDraft }),
      });
      setMemoryMarkdown(memoryDraft);
    } catch {} finally { setMemorySaving(false); }
  };

  const consolidateMemory = async () => {
    if (!username) return;
    setMemoryConsolidating(true);
    try {
      const res = await fetch(`${API_BASE}/api/memory/${encodeURIComponent(username)}/consolidate`, { method: "POST" });
      const data = await res.json();
      setMemoryMarkdown(data.longTerm || "");
      setMemoryDraft(data.longTerm || "");
    } catch {} finally { setMemoryConsolidating(false); }
  };

  const clearAllMemory = async () => {
    if (!username) return;
    if (!window.confirm("确定清空所有记忆吗？长期记忆、日志和待办都会被删除。")) return;
    try {
      await fetch(`${API_BASE}/api/memory/${encodeURIComponent(username)}`, { method: "DELETE" });
      setMemoryMarkdown("");
      setMemoryDraft("");
      setDailyLogs([]);
      setCommitments([]);
    } catch {}
  };

  const fulfillCommitment = async (id: string) => {
    if (!username) return;
    try {
      await fetch(`${API_BASE}/api/commitments/${encodeURIComponent(username)}/${encodeURIComponent(id)}/fulfill`, { method: "POST" });
      setCommitments((prev) => prev.filter((c) => c._id !== id));
    } catch {}
  };

  const deleteCommitment = async (id: string) => {
    if (!username) return;
    try {
      await fetch(`${API_BASE}/api/commitments/${encodeURIComponent(username)}/${encodeURIComponent(id)}`, { method: "DELETE" });
      setCommitments((prev) => prev.filter((c) => c._id !== id));
    } catch {}
  };

  // ── Thinking Config ──

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const toggleThinking = async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(next);
    try {
      await fetch(`${API_BASE}/api/config/thinking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinking: next }),
      });
    } catch {}
  };

  const switchEffort = async (value: "high" | "max") => {
    setReasoningEffort(value);
    try {
      await fetch(`${API_BASE}/api/config/thinking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningEffort: value }),
      });
    } catch {}
  };

  // ── Session Actions ──

  const handleRenameSession = async (sessionId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      setSessions((prev) => prev.map((s) => (s.sessionId === sessionId ? { ...s, title: trimmed } : s)));
    } catch {}
    setEditingSessionId("");
    setRenameInput("");
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!window.confirm("确定删除这个对话吗？")) return;
    try {
      await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
      setMenuOpenSessionId("");
      if (currentSessionId === sessionId) {
        setCurrentSessionId("");
        setMessages([]);
        const remaining = sessions.filter((s) => s.sessionId !== sessionId);
        if (remaining.length > 0) await switchSession(remaining[0].sessionId);
        else if (username) await createSession(username);
      }
    } catch {}
  };

  // ── Research ──

  const startResearch = useCallback(async (query: string) => {
    setResearchState({
      active: true, taskId: "", title: query, phase: "starting", detail: "",
      progress: 0, findings: [], logs: [], completed: false, error: "",
    });
    try {
      const res = await fetch(`${API_BASE}/api/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, sessionId: currentSessionId, userId: username }),
      });
      if (!res.ok || !res.body) throw new Error("Failed to start research");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event: ResearchStreamEvent = JSON.parse(line.slice(6));
            setResearchState((prev) => {
              const next = { ...prev };
              switch (event.type) {
                case "research_started":
                  next.taskId = event.taskId || "";
                  next.title = event.title || prev.title;
                  break;
                case "phase_changed":
                  next.phase = event.phase || "";
                  next.detail = event.detail || "";
                  break;
                case "progress":
                  next.progress = event.total ? Math.round(((event.current || 0) / event.total) * 100) : prev.progress;
                  next.detail = event.message || prev.detail;
                  break;
                case "finding":
                  next.findings = [...(prev.findings || []), {
                    sectionId: event.sectionId || 0,
                    heading: event.heading || "",
                    summary: event.summary || "",
                  }];
                  break;
                case "search_query":
                  next.logs = [...(prev.logs || []), { type: "search_query", query: event.query, round: event.round, timestamp: Date.now() }];
                  break;
                case "source_found":
                  next.logs = [...(prev.logs || []), { type: "source_found", title: event.title, url: event.url, snippet: event.snippet, timestamp: Date.now() }];
                  break;
                case "page_read":
                  next.logs = [...(prev.logs || []), { type: "page_read", url: event.url, title: event.title, status: event.status, timestamp: Date.now() }];
                  break;
                case "gap_detected":
                  next.detail = `发现信息缺口，正在进行补充搜索：${(event.gaps || []).join("、")}`;
                  break;
                case "report_ready":
                  next.completed = true;
                  next.phase = "completed";
                  next.progress = 100;
                  next.taskId = event.taskId || prev.taskId;
                  break;
                case "error":
                  next.error = event.message || "研究失败";
                  next.active = false;
                  break;
              }
              return next;
            });
          } catch {}
        }
      }
    } catch (err: any) {
      setResearchState((prev) => ({ ...prev, error: err.message, active: false }));
    }
  }, [currentSessionId]);

  // ── Send Message ──

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    if (deepResearchMode) {
      setDeepResearchMode(false);
      setMessages((prev) => [...prev, { role: "user" as const, content: input }]);
      setInput("");
      startResearch(input);
      return;
    }

    if (input.trim().startsWith("/research ")) {
      const researchQuery = input.trim().slice(10).trim();
      if (researchQuery) {
        setMessages((prev) => [...prev, { role: "user" as const, content: input }]);
        setInput("");
        startResearch(researchQuery);
        return;
      }
    }

    setInput("");
    setSending(true);

    if (messages.length === 0) {
      const title = text.length > 20 ? text.slice(0, 20) + "..." : text;
      fetch(`${API_BASE}/api/sessions/${encodeURIComponent(currentSessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).catch(() => {});
      setSessions((prev) => prev.map((s) => (s.sessionId === currentSessionId ? { ...s, title } : s)));
    }

    const userMsg: Message = { role: "user", content: text };
    const assistantMsg: Message = { role: "assistant", content: "", toolCalls: [], loading: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      abortControllerRef.current = new AbortController();
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: currentSessionId }),
        signal: abortControllerRef.current.signal,
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
                last.toolCalls!.push({
                  id: event.id ?? "", name: event.name ?? "",
                  arguments: event.arguments ?? {}, result: "", running: true, argumentsDelta: "",
                });
                break;
              case "tool_call_delta": {
                const idx = last.toolCalls!.findIndex((t) => t.id === event.id);
                if (idx >= 0) {
                  last.toolCalls![idx] = {
                    ...last.toolCalls![idx],
                    argumentsDelta: (last.toolCalls![idx] as any).argumentsDelta + (event.arguments_delta ?? ""),
                  };
                }
                break;
              }
              case "tool_call_end": {
                const idx = last.toolCalls!.findIndex((t) => t.id === event.id);
                if (idx >= 0) {
                  last.toolCalls![idx] = { ...last.toolCalls![idx], arguments: event.arguments ?? {}, argumentsDelta: undefined };
                }
                break;
              }
              case "tool_result": {
                const idx = last.toolCalls!.findIndex((t) => t.id === event.id);
                if (idx >= 0) {
                  last.toolCalls![idx] = { ...last.toolCalls![idx], result: event.result ?? "", running: false };
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
      if (err.name === "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], loading: false };
          return updated;
        });
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], content: `Connection error: ${err.message}` };
          return updated;
        });
      }
    }

    setMessages((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], loading: false };
      return updated;
    });
    setSending(false);
  };

  // ── Render: Login ──

  if (!username) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <div className="login-brand-title">Nexus</div>
            <div className="login-brand-subtitle">连接智能，开启对话</div>
          </div>
          <input
            className="login-input"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="用户名"
            disabled={loginLoading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleLogin(); }
            }}
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <button
            className="login-btn"
            onClick={handleLogin}
            disabled={loginLoading || !loginInput.trim()}
          >
            {loginLoading ? <><Spinner /> 登录中...</> : "进入"}
          </button>
        </div>
      </div>
    );
  }

  // ── Render: Main App ──

  return (
    <div className="app-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand">
            <span className="sidebar-brand-icon">◈</span>
            <span>Nexus</span>
          </span>
          <button className="btn-new-chat" onClick={() => createSession(username)}>+ 新会话</button>
        </div>

        <div className="session-list">
          {sessions.map((s) => {
            const showMenu = hoveredSessionId === s.sessionId || menuOpenSessionId === s.sessionId;
            const isMenuOpen = menuOpenSessionId === s.sessionId;
            return (
              <div
                key={s.sessionId}
                className={`session-item ${s.sessionId === currentSessionId ? "active" : ""}`}
                onMouseEnter={() => setHoveredSessionId(s.sessionId)}
                onMouseLeave={() => setHoveredSessionId("")}
                onClick={() => switchSession(s.sessionId)}
              >
                {editingSessionId === s.sessionId ? (
                  <input
                    autoFocus
                    className="session-rename-input"
                    value={renameInput}
                    onChange={(e) => setRenameInput(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRenameSession(s.sessionId, renameInput);
                      if (e.key === "Escape") { setEditingSessionId(""); setRenameInput(""); }
                    }}
                    onBlur={() => handleRenameSession(s.sessionId, renameInput)}
                  />
                ) : (
                  <>
                    <div className="session-title">{s.title}</div>
                    <div className="session-time">{formatTime(s.updatedAt)}</div>
                  </>
                )}
                {showMenu && editingSessionId !== s.sessionId && (
                  <button
                    className={`session-menu-btn ${isMenuOpen ? "open" : ""}`}
                    onClick={(e) => { e.stopPropagation(); setMenuOpenSessionId(isMenuOpen ? "" : s.sessionId); }}
                  >
                    ⋮
                  </button>
                )}
                {isMenuOpen && (
                  <div className="session-menu-dropdown">
                    <button className="session-menu-item" onClick={(e) => { e.stopPropagation(); setMenuOpenSessionId(""); setEditingSessionId(s.sessionId); setRenameInput(s.title); }}>
                      ✎ 重命名
                    </button>
                    <button className="session-menu-delete" onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.sessionId); }}>
                      🗑 删除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sidebar-controls">
          <div className="control-row">
            <span className="control-label">主题</span>
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === "dark" ? "切换到浅色" : "切换到深色"}
            >
              {theme === "dark" ? "🌙" : "☀️"}
            </button>
          </div>
          <div className="control-row">
            <span className="control-label">Thinking</span>
            <button className={`toggle-switch ${thinkingEnabled ? "on" : ""}`} onClick={toggleThinking}>
              <span className="knob" />
            </button>
          </div>
          {thinkingEnabled && (
            <div className="effort-row">
              <button className={`effort-btn ${reasoningEffort === "high" ? "active" : ""}`} onClick={() => switchEffort("high")}>high</button>
              <button className={`effort-btn ${reasoningEffort === "max" ? "active" : ""}`} onClick={() => switchEffort("max")}>max</button>
            </div>
          )}
        </div>

        <div className="sidebar-section">
          <button className="sidebar-btn" onClick={() => { setMemoryOpen(true); loadMemory(); }}>
            <MemoryIcon />
            我的记忆
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">技能</div>
          {skills.length === 0 ? (
            <div style={{ fontSize: "12px", color: "var(--text-muted)", padding: "4px 0" }}>加载中...</div>
          ) : (
            <div className="skills-list">
              {skills.map((s) => (
                <div key={s._id} className="skill-row">
                  <span className="skill-name">{s.name}</span>
                  <button className={`toggle-switch ${s.enabled ? "on" : ""}`} onClick={() => toggleSkill(s._id, s.enabled)}>
                    <span className="knob" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="username">{username}</span>
          <button className="logout-btn" onClick={handleLogout}>退出</button>
        </div>
      </aside>

      {/* ── Main Chat Area ── */}
      <main className="main-area">
        <div className="messages-container">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon">✦</div>
              <div className="empty-state-title">开始对话</div>
              <div className="empty-state-subtitle">提问、研究、创造 — 让 AI 为你工作</div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`message-row ${msg.role}`}>
              <div className={`avatar ${msg.role}`}>{msg.role === "user" ? "You" : "AI"}</div>
              {msg.role === "user" ? (
                <div className="user-bubble">{msg.content}</div>
              ) : (
                <div className="assistant-content">
                  <div className="assistant-header">Nexus</div>
                  {msg.reasoning && <ThinkingBlock content={msg.reasoning} />}
                  {msg.content && <MarkdownContent content={msg.content} />}
                  {msg.toolCalls?.map((tc, j) => (
                    <ToolCallBlock key={tc.id || j} tc={tc} />
                  ))}
                  {msg.loading && !msg.content && !msg.toolCalls?.length && (
                    <div className="typing-indicator"><Spinner /> thinking...</div>
                  )}
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />

          {/* Research Progress */}
          {researchState.active && (
            <div className="research-card">
              <div className="research-card-header">
                <span style={{ fontSize: "20px" }}>🔬</span>
                <span className="research-card-title">深度研究进行中</span>
                {researchState.title && <span className="research-card-query">: {researchState.title}</span>}
              </div>
              <div className="research-progress-track">
                <div className="research-progress-bar" style={{ width: `${researchState.progress}%` }} />
              </div>
              <div className="research-status">
                {researchState.detail || researchState.phase || "准备中..."}
              </div>
              {researchState.logs.length > 0 && (
                <div className="research-divider">
                  <div className="research-section-label">研究链条</div>
                  <ResearchChain logs={researchState.logs} />
                </div>
              )}
              {researchState.findings.length > 0 && (
                <div className="research-divider">
                  <div className="research-section-label">已完成 {researchState.findings.length} 个章节的调研</div>
                  {researchState.findings.map((f, i) => (
                    <div key={i} className="research-finding">
                      <span className="research-finding-check">✓</span>
                      <span className="research-finding-heading">{f.heading}</span>
                      <p className="research-finding-summary">
                        {f.summary.slice(0, 120)}{f.summary.length > 120 ? "..." : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {researchState.error && <div className="research-error">❌ {researchState.error}</div>}
            </div>
          )}

          {/* Report Ready */}
          {researchState.completed && researchState.taskId && (
            <div className="report-card">
              <div className="report-card-header">
                <span style={{ fontSize: "20px" }}>📊</span>
                <span>调研报告已生成</span>
              </div>
              <div className="report-actions">
                <a
                  className="btn-success"
                  href={`${API_BASE}/api/research/${researchState.taskId}/report`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看报告 →
                </a>
                <button
                  className="btn-primary"
                  onClick={async () => {
                    if (!username || !researchState.taskId) return;
                    try {
                      const res = await fetch(`${API_BASE}/api/research/${researchState.taskId}/save-as-skill`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ userId: username }),
                      });
                      const data = await res.json();
                      if (data.success) {
                        setResearchSaved(true);
                        alert(`已保存为 Skill: ${data.skillName}`);
                        loadSkills();
                      } else {
                        alert("保存失败: " + (data.error || "未知错误"));
                      }
                    } catch (err: any) { alert("保存失败: " + err.message); }
                  }}
                  disabled={researchSaved}
                  style={{ background: researchSaved ? "var(--bg-hover)" : undefined }}
                >
                  {researchSaved ? "✓ 已保存为 Skill" : "💾 保存为 Skill"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Input Bar ── */}
        <form
          className="input-bar"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          <div className="input-wrapper">
            <textarea
              className="input-field"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入消息..."
              disabled={sending}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="input-actions">
              <button
                type="button"
                className={`btn-research-toggle ${deepResearchMode ? "active" : ""}`}
                onClick={() => setDeepResearchMode(!deepResearchMode)}
                title="深度研究模式"
              >
                🔬 {deepResearchMode ? "研究模式" : "深度研究"}
              </button>
            </div>
          </div>
          {sending ? (
            <button className="btn-stop" type="button" onClick={(e) => { e.preventDefault(); handleStop(); }}>
              <StopIcon size={14} />
            </button>
          ) : (
            <button className="btn-send" type="submit" disabled={!input.trim()}>
              <SendIcon size={16} />
            </button>
          )}
        </form>
      </main>

      {/* ── Memory Drawer ── */}
      {memoryOpen && (
        <>
          <div className="memory-overlay" onClick={() => setMemoryOpen(false)} />
          <div className="memory-drawer">
            <div className="memory-drawer-header">
              <h3 className="memory-drawer-title">我的记忆</h3>
              <button className="memory-drawer-close" onClick={() => setMemoryOpen(false)}>
                <CloseIcon size={18} />
              </button>
            </div>
            <div className="memory-tabs">
              <button className={`memory-tab ${memoryTab === "longTerm" ? "active" : ""}`} onClick={() => setMemoryTab("longTerm")}>长期记忆</button>
              <button className={`memory-tab ${memoryTab === "dailyLogs" ? "active" : ""}`} onClick={() => setMemoryTab("dailyLogs")}>每日日志</button>
              <button className={`memory-tab ${memoryTab === "commitments" ? "active" : ""}`} onClick={() => setMemoryTab("commitments")}>
                待办 {commitments.length > 0 ? `(${commitments.length})` : ""}
              </button>
            </div>
            <div className="memory-body">
              {memoryLoading ? (
                <div className="memory-empty"><Spinner /> 加载中...</div>
              ) : memoryTab === "longTerm" ? (
                <>
                  <p className="memory-hint">AI 每次会话都会读取这里的信息。你可以直接编辑，也可以让 AI 从日志自动整理。</p>
                  <textarea
                    className="memory-textarea"
                    value={memoryDraft}
                    onChange={(e) => setMemoryDraft(e.target.value)}
                    placeholder="# 用户偏好\n- 喜欢简洁的回答\n\n# 技术背景\n- ..."
                  />
                </>
              ) : memoryTab === "dailyLogs" ? (
                <div className="logs-list">
                  {dailyLogs.length === 0 ? (
                    <div className="memory-empty">暂无日志。对话后会自动生成。</div>
                  ) : (
                    dailyLogs.map((log) => (
                      <div key={log.date} className="log-item">
                        <div className="log-date">{log.date}</div>
                        <pre className="log-content">{log.content}</pre>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="logs-list">
                  {commitments.length === 0 ? (
                    <div className="memory-empty">暂无待办。提到"记得提醒我"之类的事情会被自动记录。</div>
                  ) : (
                    commitments.map((c) => (
                      <div key={c._id} className="commitment-item">
                        <div className="commitment-content">{c.content}</div>
                        <div className="commitment-actions">
                          <button className="commitment-done" onClick={() => fulfillCommitment(c._id)} title="完成">✓</button>
                          <button className="commitment-delete" onClick={() => deleteCommitment(c._id)} title="删除">✕</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="memory-footer">
              <button className="btn-danger" onClick={clearAllMemory}>清空</button>
              {memoryTab === "longTerm" && (
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="btn-secondary" onClick={consolidateMemory} disabled={memoryConsolidating}>
                    {memoryConsolidating ? "整理中..." : "从日志整理"}
                  </button>
                  <button className="btn-primary" onClick={saveMemory} disabled={memorySaving}>
                    {memorySaving ? "保存中..." : "保存"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Team Panel */}
      <TeamPanel
        team={team}
        teammates={teammates}
        tasks={teamTasks}
        messages={teamMessages}
        connected={teamConnected}
        open={teamPanelOpen}
        onToggle={() => setTeamPanelOpen((v) => !v)}
      />
    </div>
  );
}
