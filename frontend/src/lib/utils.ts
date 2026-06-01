export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3000";

/** Strip "mcp__servername__" prefix for cleaner display */
export function displayName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

/** Get a short label from tool arguments for inline preview */
export function argPreview(args: Record<string, unknown>): string {
  for (const key of ["query", "search_query", "url", "path", "name", "question"]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      return val.length > 60 ? val.slice(0, 60) + "..." : val;
    }
  }
  return "";
}

/** Format timestamp to readable string */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  if (isToday) return `${h}:${m}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
}
