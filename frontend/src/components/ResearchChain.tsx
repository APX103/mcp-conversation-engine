import { useState } from "react";
import type { ResearchLog } from "../types";

export function ResearchChain({ logs }: { logs: ResearchLog[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Merge page_read start/done: keep latest per URL
  const pageReadMap = new Map<string, ResearchLog>();
  for (const log of logs) {
    if (log.type === "page_read" && log.url) {
      pageReadMap.set(log.url, log);
    }
  }

  const displayLogs = logs.filter((log) => {
    if (log.type !== "page_read") return true;
    if (!log.url) return true;
    return pageReadMap.get(log.url) === log;
  });

  const getNodeStyle = (type: ResearchLog["type"]) => {
    switch (type) {
      case "search_query": return { icon: "🔍", className: "search", color: "#60a5fa" };
      case "source_found": return { icon: "↳", className: "source", color: "#34d399" };
      case "page_read": return { icon: "📄", className: "read", color: "#fbbf24" };
      default: return { icon: "•", className: "search", color: "#a5b4fc" };
    }
  };

  const getHostname = (url?: string) => {
    if (!url) return "";
    try { return new URL(url).hostname; } catch { return url; }
  };

  return (
    <div className="research-chain">
      <div className="research-chain-line" />
      {displayLogs.map((log, i) => {
        const isExpanded = expanded.has(i);
        const style = getNodeStyle(log.type);
        return (
          <div key={i} className="chain-node">
            <div
              className="chain-dot"
              style={{ background: style.color }}
            />
            <div
              className={`chain-card ${style.className} ${log.type === "source_found" ? "clickable" : ""}`}
              onClick={() => log.type === "source_found" && toggle(i)}
            >
              <div className="chain-content">
                <span style={{ fontSize: "11px" }}>{style.icon}</span>
                {log.type === "search_query" && (
                  <span>
                    <span className="chain-action">搜索</span>
                    <span className="chain-detail">{log.query}</span>
                    {log.round && log.round > 1 && (
                      <span className="chain-round">(第{log.round}轮)</span>
                    )}
                  </span>
                )}
                {log.type === "source_found" && (
                  <span>
                    <span className="chain-action">找到</span>
                    <span className="chain-detail">{log.title || "未知网页"}</span>
                  </span>
                )}
                {log.type === "page_read" && (
                  <span>
                    <span className="chain-action">
                      {log.status === "done" ? "已读" : log.status === "error" ? "失败" : "阅读"}
                    </span>
                    <span className="chain-detail">{log.title || log.url}</span>
                  </span>
                )}
              </div>

              {log.type === "source_found" && isExpanded && log.snippet && (
                <div className="chain-snippet">
                  {log.snippet.slice(0, 150)}{log.snippet.length > 150 ? "..." : ""}
                </div>
              )}

              {log.type === "source_found" && log.url && (
                <div className="chain-hostname">{getHostname(log.url)}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
