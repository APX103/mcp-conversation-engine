import type { ToolDef } from "./types.js";
import { readFile, writeFile, readdir, mkdir, stat } from "fs/promises";
import { resolve, relative, dirname, join } from "path";
import { fileURLToPath } from "url";

// ── Workspace security guard ──

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

function resolveWorkspacePath(inputPath: string): string {
  // Reject absolute paths
  if (inputPath.startsWith("/") || inputPath.match(/^[a-zA-Z]:\\/)) {
    throw new Error("Absolute paths are not allowed. Use a relative path within the project.");
  }
  const target = resolve(WORKSPACE_ROOT, inputPath);
  const rel = relative(WORKSPACE_ROOT, target);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace. Only project-relative paths are allowed.");
  }
  return target;
}

// ── tool_search: Deferred MCP tool schema lookup ──

function createToolSearch(getToolSchemas: (namePattern: string) => ToolDef[]): ToolDef {
  return {
    name: "tool_search",
    description:
      "Search available MCP tools by name and get their full parameter schemas. " +
      "Use this when you know a tool name but need to know what parameters it accepts.",
    parameters: [
      { name: "name", type: "string", description: "Partial or full tool name to search for", required: true },
    ],
    async execute(args) {
      const name = (args.name as string).toLowerCase();
      const matches = getToolSchemas(name);
      if (matches.length === 0) return `No tools found matching "${args.name}".`;
      return matches
        .map((t) => `${t.name}: ${t.description}\nParameters: ${JSON.stringify(t.parameters)}`)
        .join("\n\n");
    },
  };
}

// ── read_file ──

function createReadFile(): ToolDef {
  return {
    name: "read_file",
    description:
      "Read the contents of a text file within the project workspace. " +
      "Returns the full content or a specific range of lines.",
    parameters: [
      { name: "path", type: "string", description: "Relative path to the file (e.g. 'backend/src/index.ts')", required: true },
      { name: "offset", type: "number", description: "1-based line number to start reading from", required: false },
      { name: "limit", type: "number", description: "Maximum number of lines to read", required: false },
    ],
    async execute(args) {
      const filePath = resolveWorkspacePath(args.path as string);
      let content = await readFile(filePath, "utf-8");
      const offset = typeof args.offset === "number" ? Math.max(1, args.offset) : 1;
      const limit = typeof args.limit === "number" ? Math.max(1, args.limit) : undefined;

      const lines = content.split("\n");
      const start = offset - 1;
      const end = limit !== undefined ? start + limit : lines.length;
      const sliced = lines.slice(start, end);

      const header = limit !== undefined
        ? `(lines ${offset}-${Math.min(end, lines.length)} of ${lines.length})\n\n`
        : `(total ${lines.length} lines)\n\n`;
      return header + sliced.join("\n");
    },
  };
}

// ── list_directory ──

function createListDirectory(): ToolDef {
  return {
    name: "list_directory",
    description:
      "List files and subdirectories within a directory in the project workspace. " +
      "Optionally list recursively.",
    parameters: [
      { name: "path", type: "string", description: "Relative path to the directory (e.g. 'backend/src')", required: true },
      { name: "recursive", type: "boolean", description: "List all files recursively", required: false },
    ],
    async execute(args) {
      const dirPath = resolveWorkspacePath(args.path as string);
      const recursive = args.recursive === true;

      async function walk(dir: string, prefix = ""): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const name = entry.name;
          if (name.startsWith(".")) continue; // skip hidden
          const fullPath = join(dir, name);
          const relPath = prefix ? `${prefix}/${name}` : name;
          if (entry.isDirectory()) {
            lines.push(`${relPath}/`);
            if (recursive) {
              lines.push(...(await walk(fullPath, relPath)));
            }
          } else {
            lines.push(relPath);
          }
        }
        return lines;
      }

      const items = await walk(dirPath);
      return items.length > 0 ? items.join("\n") : "(empty directory)";
    },
  };
}

// ── write_file ──

function createWriteFile(): ToolDef {
  return {
    name: "write_file",
    description:
      "Write content to a file within the project workspace. " +
      "Creates parent directories if needed. Use append=true to append instead of overwrite.",
    parameters: [
      { name: "path", type: "string", description: "Relative path to the file", required: true },
      { name: "content", type: "string", description: "Content to write", required: true },
      { name: "append", type: "boolean", description: "Append to existing file instead of overwriting", required: false },
    ],
    async execute(args) {
      const filePath = resolveWorkspacePath(args.path as string);
      const content = args.content as string;
      const append = args.append === true;

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content + (append && content.endsWith("\n") ? "" : "\n"), {
        flag: append ? "a" : "w",
      });
      return append ? `Appended to ${args.path}` : `Wrote ${content.length} chars to ${args.path}`;
    },
  };
}

// ── edit_file ──

function createEditFile(): ToolDef {
  return {
    name: "edit_file",
    description:
      "Replace a specific string in a file with another string. " +
      "old_string must match exactly (including whitespace). Use this for precise edits.",
    parameters: [
      { name: "path", type: "string", description: "Relative path to the file", required: true },
      { name: "old_string", type: "string", description: "Exact string to replace", required: true },
      { name: "new_string", type: "string", description: "Replacement string", required: true },
    ],
    async execute(args) {
      const filePath = resolveWorkspacePath(args.path as string);
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;

      const content = await readFile(filePath, "utf-8");
      if (!content.includes(oldStr)) {
        return `Error: old_string not found in ${args.path}. The file may have changed or the string may not match exactly.`;
      }

      const occurrences = content.split(oldStr).length - 1;
      if (occurrences > 1) {
        return `Error: old_string appears ${occurrences} times in ${args.path}. Please provide a more unique string.`;
      }

      const updated = content.replace(oldStr, newStr);
      await writeFile(filePath, updated, "utf-8");
      return `Edited ${args.path}: replaced ${oldStr.length} chars with ${newStr.length} chars.`;
    },
  };
}

// ── fetch_url ──

function createFetchUrl(): ToolDef {
  return {
    name: "fetch_url",
    description:
      "Make an HTTP request to a URL. Returns the response body as text. " +
      "For JSON APIs, the response will be raw JSON text.",
    parameters: [
      { name: "url", type: "string", description: "Target URL", required: true },
      { name: "method", type: "string", description: "HTTP method: GET, POST, PUT, DELETE (default GET)", required: false },
      { name: "headers", type: "string", description: "JSON string of headers, e.g. '{\"Authorization\":\"Bearer xxx\"}'", required: false },
      { name: "body", type: "string", description: "Request body (for POST/PUT)", required: false },
    ],
    async execute(args) {
      const url = args.url as string;
      const method = (args.method as string)?.toUpperCase() || "GET";
      const body = args.body as string | undefined;

      let headers: Record<string, string> = {};
      if (args.headers) {
        try {
          headers = JSON.parse(args.headers as string);
        } catch {
          return `Error: headers is not valid JSON: ${args.headers}`;
        }
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body || undefined,
      });

      const text = await res.text();
      const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n... (truncated)" : text;
      return `Status: ${res.status} ${res.statusText}\n\n${truncated}`;
    },
  };
}

// ── Export ──

export function createBuiltinTools(opts: {
  getToolSchemas: (namePattern: string) => ToolDef[];
  mode?: "blacklist" | "whitelist";
  disabled?: string[];
  enabled?: string[];
}): ToolDef[] {
  const all = [
    createToolSearch(opts.getToolSchemas),
    createReadFile(),
    createListDirectory(),
    createWriteFile(),
    createEditFile(),
    createFetchUrl(),
  ];

  const mode = opts.mode ?? "blacklist";

  if (mode === "whitelist" && opts.enabled) {
    const allowed = new Set(opts.enabled.map((n) => n.toLowerCase()));
    const result = all.filter((t) => allowed.has(t.name.toLowerCase()));
    console.log(`[Tools] whitelist mode: ${result.map((t) => t.name).join(", ")}`);
    return result;
  }

  const disabled = new Set((opts.disabled ?? []).map((n) => n.toLowerCase()));
  const result = all.filter((t) => !disabled.has(t.name.toLowerCase()));
  if (disabled.size > 0) {
    console.log(
      `[Tools] disabled: ${Array.from(disabled).filter((n) => all.some((t) => t.name.toLowerCase() === n)).join(", ")}`
    );
  }
  return result;
}
