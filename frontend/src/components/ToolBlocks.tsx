import { useState, useEffect } from "react";
import { displayName, argPreview, API_BASE } from "../lib/utils";
import { Spinner, CheckIcon, ChevronIcon } from "./Icons";
import type { ToolCallItem, SubagentEvent } from "../types";

// ── AgentBlock ──

function AgentBlock({ tc }: { tc: ToolCallItem }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SubagentEvent[]>([]);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const preview = argPreview(tc.arguments);

  let subagentId = "";
  let task = preview;
  try {
    const result = JSON.parse(tc.result || "{}");
    subagentId = result.subagentId || "";
    task = (tc.arguments?.task as string) || preview;
  } catch {
    // ignore
  }

  // Auto-connect SSE as soon as we have a subagentId, regardless of open state.
  // This ensures completed status is updated and events are buffered for when user expands.
  useEffect(() => {
    if (!subagentId) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/subagent/${encodeURIComponent(subagentId)}/stream`, {
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok || !res.body) return;
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
            const event: SubagentEvent = JSON.parse(line.slice(6));
            setEvents((prev) => [...prev, event]);
            if (event.type === "subagent_completed") setCompleted(true);
            if (event.type === "error") setError(event.message || "失败");
          } catch {}
        }
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [subagentId]);

  return (
    <div className="tool-block agent">
      <div className="tool-header" onClick={() => setOpen(!open)}>
        <span style={{ color: completed ? "var(--success)" : "var(--agent-text)" }}>
          {completed ? <CheckIcon /> : <Spinner />}
        </span>
        <ChevronIcon open={open} />
        <span className="tool-label">
          <span className="tool-name" style={{ color: "var(--agent-text)" }}>🔧 spawn_agent</span>
          <span className="tool-preview">{task}</span>
          {!completed && <span className="tool-running">running...</span>}
        </span>
      </div>

      {open && (
        <div className="tool-details">
          <div className="detail-section">
            <div className="detail-label">Task</div>
            <pre className="tool-code">{JSON.stringify(tc.arguments, null, 2)}</pre>
          </div>

          {events.length > 0 && (
            <div className="detail-section">
              <div className="detail-label">执行过程（只读）</div>
              <div className="agent-events">
                {events.map((ev, i) => {
                  if (ev.type === "reasoning" && ev.content) {
                    return (
                      <div key={i} className="agent-event-thinking">
                        <strong>💭 Thinking</strong>
                        <pre>{ev.content}</pre>
                      </div>
                    );
                  }
                  if (ev.type === "text" && ev.content) {
                    return <div key={i} className="agent-event-text">{ev.content}</div>;
                  }
                  if (ev.type === "tool_call_end" && ev.name) {
                    return (
                      <div key={i} className="agent-event-tool">
                        <span style={{ color: "var(--info)" }}>🔧</span> {displayName(ev.name)} {argPreview(ev.arguments || {})}
                      </div>
                    );
                  }
                  if (ev.type === "tool_result") {
                    return (
                      <div key={i} className="agent-event-result">
                        ↳ {ev.result?.slice(0, 100)}{ev.result && ev.result.length > 100 ? "..." : ""}
                      </div>
                    );
                  }
                  if (ev.type === "subagent_completed") {
                    return <div key={i} className="agent-event-completed">✅ 子 agent 已完成</div>;
                  }
                  if (ev.type === "error") {
                    return <div key={i} className="agent-event-error">❌ {ev.message}</div>;
                  }
                  return null;
                })}
              </div>
            </div>
          )}

          {error && <div style={{ color: "var(--error)" }}>❌ {error}</div>}

          {tc.result && !tc.running && (
            <div className="detail-section">
              <div className="detail-label">Result</div>
              <pre className="tool-code">{tc.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ToolCallBlock ──

export function ToolCallBlock({ tc }: { tc: ToolCallItem }) {
  if (tc.name === "spawn_agent" || tc.name === "mcp__spawn_agent") {
    return <AgentBlock tc={tc} />;
  }

  const [open, setOpen] = useState(false);
  const shortName = displayName(tc.name);
  const preview = argPreview(tc.arguments);
  const isRunning = tc.running;
  const isStreaming = !!tc.argumentsDelta;

  const displayArgs = isStreaming
    ? tc.argumentsDelta!
    : JSON.stringify(tc.arguments, null, 2);

  return (
    <div className="tool-block">
      <div className="tool-header" onClick={() => setOpen(!open)}>
        {isRunning ? (
          <span style={{ color: "var(--accent)" }}><Spinner /></span>
        ) : (
          <span style={{ color: "var(--success)" }}><CheckIcon /></span>
        )}
        <ChevronIcon open={open} />
        <span className="tool-label">
          <span className="tool-name">{shortName}</span>
          {isStreaming ? (
            <span className="tool-running">receiving args...</span>
          ) : preview && !isRunning ? (
            <span className="tool-preview">{preview}</span>
          ) : null}
          {!isStreaming && isRunning && <span className="tool-running">running...</span>}
        </span>
      </div>

      {open && (
        <div className="tool-details">
          <div className="detail-section">
            <div className="detail-label">Arguments</div>
            <pre className="tool-code">{displayArgs}</pre>
          </div>

          {tc.result && !isRunning && (
            <div className="detail-section">
              <div className="detail-label">Result</div>
              <pre className="tool-code">{tc.result}</pre>
            </div>
          )}

          {isRunning && !isStreaming && (
            <div style={{ color: "var(--text-tertiary)", fontStyle: "italic", fontSize: "12px" }}>
              Waiting for result...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
