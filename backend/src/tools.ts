import type { ToolDef } from "./types.js";
import type { DbManager } from "./db.js";
import type { ServiceManager } from "./services/manager.js";
import { parseSkillMarkdown } from "./skill.js";
import { readFile, writeFile, readdir, mkdir, stat } from "fs/promises";
import { resolve, relative, dirname, join } from "path";
import { fileURLToPath } from "url";

// ── Workspace security guard ──

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "workspace"
);

function resolveWorkspacePath(inputPath: string): string {
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
    async execute(args, _userId?) {
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
    async execute(args, _userId?) {
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
    async execute(args, _userId?) {
      const dirPath = resolveWorkspacePath(args.path as string);
      const recursive = args.recursive === true;

      async function walk(dir: string, prefix = ""): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const name = entry.name;
          if (name.startsWith(".")) continue;
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
    async execute(args, _userId?) {
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
    async execute(args, _userId?) {
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
      { name: "headers", type: "string", description: "JSON string of headers", required: false },
      { name: "body", type: "string", description: "Request body (for POST/PUT)", required: false },
    ],
    async execute(args, _userId?) {
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

      const res = await fetch(url, { method, headers, body: body || undefined });
      const text = await res.text();
      const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n... (truncated)" : text;
      return `Status: ${res.status} ${res.statusText}\n\n${truncated}`;
    },
  };
}

// ── Skill management ──

function createSkillList(db: DbManager): ToolDef {
  return {
    name: "skill_list",
    description: "List all installed skills for the current user.",
    parameters: [],
    async execute(_args, userId) {
      if (!userId) return "Error: userId not available.";
      const skills = await db.getSkills(userId);
      if (skills.length === 0) return "No skills installed.";
      return skills
        .map((s) => `- ${s.name} (${s.builtin ? "builtin" : "custom"}, ${s.enabled ? "enabled" : "disabled"})\n  ${s.description}`)
        .join("\n\n");
    },
  };
}

function createSkillCreate(db: DbManager): ToolDef {
  return {
    name: "skill_create",
    description:
      "Create a new skill from a SKILL.md markdown string with YAML frontmatter. " +
      "The markdown must contain: name, description, triggers (array), and instruction content.",
    parameters: [
      { name: "markdown", type: "string", description: "Full SKILL.md with YAML frontmatter", required: true },
    ],
    async execute(args, userId) {
      if (!userId) return "Error: userId not available.";
      const parsed = parseSkillMarkdown(args.markdown as string);
      if (!parsed) {
        return "Error: Invalid SKILL.md format. Must have YAML frontmatter with name, description, triggers.";
      }
      await db.addSkill({
        userId,
        name: parsed.name,
        description: parsed.description,
        triggers: parsed.triggers,
        content: parsed.content,
        enabled: true,
        builtin: false,
      });
      return `Created skill "${parsed.name}": ${parsed.description}`;
    },
  };
}

function createSkillUpdate(db: DbManager): ToolDef {
  return {
    name: "skill_update",
    description: "Update an existing skill by name. Replaces the entire skill content with new markdown.",
    parameters: [
      { name: "name", type: "string", description: "Name of the skill to update", required: true },
      { name: "markdown", type: "string", description: "New full SKILL.md with YAML frontmatter", required: true },
    ],
    async execute(args, userId) {
      if (!userId) return "Error: userId not available.";
      const skills = await db.getSkills(userId);
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) return `Skill "${args.name}" not found.`;
      if (skill.builtin) return `Cannot update builtin skill "${args.name}".`;
      const parsed = parseSkillMarkdown(args.markdown as string);
      if (!parsed) return "Error: Invalid SKILL.md format.";
      await db.updateSkill(skill._id!, {
        name: parsed.name,
        description: parsed.description,
        triggers: parsed.triggers,
        content: parsed.content,
      });
      return `Updated skill "${parsed.name}".`;
    },
  };
}

function createSkillDelete(db: DbManager): ToolDef {
  return {
    name: "skill_delete",
    description: "Delete a skill by name. Builtin skills cannot be deleted.",
    parameters: [
      { name: "name", type: "string", description: "Name of the skill to delete", required: true },
    ],
    async execute(args, userId) {
      if (!userId) return "Error: userId not available.";
      const skills = await db.getSkills(userId);
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) return `Skill "${args.name}" not found.`;
      if (skill.builtin) return `Cannot delete builtin skill "${args.name}".`;
      await db.deleteSkill(skill._id!);
      return `Deleted skill "${args.name}".`;
    },
  };
}

// ── Dynamic service management ──

function createServiceCreate(sm: ServiceManager): ToolDef {
  return {
    name: "create_service",
    description:
      "Create and start a dynamic Node.js HTTP service. " +
      "The service runs as a child process with an assigned port. " +
      "Use process.env.SERVICE_PORT to get the assigned port in your code. " +
      "Returns the service ID, port, and URL.",
    parameters: [
      { name: "name", type: "string", description: "Service name (must be unique)", required: true },
      { name: "code", type: "string", description: "Node.js ESM code to run. Use process.env.SERVICE_PORT for the assigned port.", required: true },
    ],
    async execute(args) {
      try {
        const info = await sm.createService(args.code as string, { name: args.name as string });
        return `Service created:\n  ID: ${info.id}\n  Port: ${info.port}\n  Status: ${info.status}\n  URL (container): http://0.0.0.0:${info.port}\n  URL (host): http://host.docker.internal:${info.port}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

function createServiceList(sm: ServiceManager): ToolDef {
  return {
    name: "list_services",
    description: "List all running dynamic services and their ports. Also shows available ports in the pool.",
    parameters: [],
    async execute() {
      const services = sm.listServices();
      if (services.length === 0) {
        const ports = sm.getAvailablePorts();
        return `No services running.\nAvailable port pool: ${ports.start}-${ports.end} (${ports.available.length} free)`;
      }
      const lines = services.map(
        (s) => `  ${s.id}: port=${s.port} status=${s.status} pid=${s.pid ?? "-"} started=${s.startedAt ?? "-"}`
      );
      const ports = sm.getAvailablePorts();
      return `Running services (${services.length}):\n${lines.join("\n")}\n\nAvailable ports: ${ports.available.join(", ") || "none"} (${ports.available.length}/${ports.available.length + services.length})`;
    },
  };
}

function createServiceStop(sm: ServiceManager): ToolDef {
  return {
    name: "stop_service",
    description: "Stop a running dynamic service by ID.",
    parameters: [
      { name: "id", type: "string", description: "Service ID to stop", required: true },
    ],
    async execute(args) {
      const ok = sm.stopService(args.id as string);
      return ok ? `Service "${args.id}" stopped.` : `Service "${args.id}" not found.`;
    },
  };
}

function createServiceLogs(sm: ServiceManager): ToolDef {
  return {
    name: "service_logs",
    description: "Get recent logs from a dynamic service.",
    parameters: [
      { name: "id", type: "string", description: "Service ID", required: true },
      { name: "tail", type: "number", description: "Number of log lines to return (default 30)", required: false },
    ],
    async execute(args) {
      const logs = sm.getServiceLogs(args.id as string, (args.tail as number) || 30);
      if (logs.length === 0) return `No logs for "${args.id}".`;
      return logs.join("\n");
    },
  };
}

// ── A2A tools ──

const A2A_CENTER_URL = process.env.A2A_CENTER_URL || "http://a2a-center:8888";

function createA2AListAgents(): ToolDef {
  return {
    name: "a2a_list_agents",
    description:
      "List all registered A2A agents from the A2A Center discovery service. " +
      "Returns agent_id, name, description, URL, and skills for each agent. " +
      "Use this to find other agents you can send tasks to.",
    parameters: [],
    async execute() {
      try {
        const res = await fetch(`${A2A_CENTER_URL}/dashboard/api/agents`);
        if (!res.ok) return `Error: HTTP ${res.status}`;
        const data = await res.json();
        const agents = data.agents || [];
        if (agents.length === 0) return "No agents registered in A2A-center.";
        return agents
          .map(
            (a: any) =>
              `- ${a.id}: ${a.card?.name || "Unnamed"}\n  ` +
              `URL: ${a.card?.url || "none"}\n  ` +
              `Skills: ${(a.card?.skills || []).map((s: any) => s.id).join(", ") || "none"}\n  ` +
              `Desc: ${a.card?.description || ""}`
          )
          .join("\n\n");
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

function createA2ASendTask(): ToolDef {
  return {
    name: "a2a_send_task",
    description:
      "Send a task to another A2A agent via the A2A Center. " +
      "You need an agent_id (discover via a2a_list_agents) and a message text. " +
      "The task is routed asynchronously. Use a2a_get_task_status to poll for the result.",
    parameters: [
      { name: "target_agent_id", type: "string", description: "The recipient agent_id from a2a_list_agents", required: true },
      { name: "message", type: "string", description: "The task message to send", required: true },
      { name: "task_id", type: "string", description: "Optional custom task ID (auto-generated if omitted)", required: false },
    ],
    async execute(args) {
      const target = args.target_agent_id as string;
      const message = args.message as string;
      const taskId = (args.task_id as string) || `task_${crypto.randomUUID().slice(0, 8)}`;

      try {
        // We need sender credentials. Since the backend itself is an A2A agent,
        // we use its own agent_id/token if available. Otherwise register a temporary sender.
        // For simplicity, we use the backend's receiver credentials from env.
        const senderId = process.env.A2A_AGENT_ID;
        const senderToken = process.env.A2A_AGENT_TOKEN;

        let headers: Record<string, string> = { "Content-Type": "application/json" };
        if (senderId && senderToken) {
          headers["X-Agent-Id"] = senderId;
          headers["X-Token"] = senderToken;
        }

        const res = await fetch(`${A2A_CENTER_URL}/v1/tasks/send`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: taskId,
            message: {
              role: "user",
              parts: [{ type: "text", text: message }],
            },
            params: { target },
          }),
        });

        const text = await res.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        if (!res.ok) {
          return `Error sending task: HTTP ${res.status}\n${JSON.stringify(data, null, 2)}`;
        }

        return `Task sent successfully.\nTask ID: ${taskId}\nInitial state: ${data.status?.state || "unknown"}\nRecipient: ${target}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

function createA2AGetTaskStatus(): ToolDef {
  return {
    name: "a2a_get_task_status",
    description:
      "Get the status and result of a task sent via a2a_send_task. " +
      "Poll this tool until the state is 'completed' or 'failed'. " +
      "All queries go through the A2A-center (proxied, not point-to-point). " +
      "Returns the task state and any result artifacts from the recipient agent.",
    parameters: [
      { name: "task_id", type: "string", description: "The task ID returned by a2a_send_task", required: true },
    ],
    async execute(args) {
      const taskId = args.task_id as string;

      try {
        const senderId = process.env.A2A_AGENT_ID;
        const senderToken = process.env.A2A_AGENT_TOKEN;
        let headers: Record<string, string> = {};
        if (senderId && senderToken) {
          headers["X-Agent-Id"] = senderId;
          headers["X-Token"] = senderToken;
        }

        // Query A2A-center directly (proxied, NOT point-to-point)
        const res = await fetch(`${A2A_CENTER_URL}/v1/tasks/get?taskId=${encodeURIComponent(taskId)}`, { headers });
        if (!res.ok) {
          const text = await res.text();
          return `Error querying A2A-center: HTTP ${res.status}\n${text}`;
        }
        const task = await res.json();

        const state = task.status?.state || "unknown";
        let result = `Task ID: ${taskId}\nState: ${state}\nFrom: ${task.metadata?.fromAgent}\nTarget: ${task.metadata?.targetAgent}`;

        if (task.artifacts && task.artifacts.length > 0) {
          const artifactText = task.artifacts[0]?.parts?.[0]?.text;
          if (artifactText) {
            result += `\n\n--- Result from agent ---\n${artifactText}`;
          }
        }

        return result;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}

// ── Export ──

export function createBuiltinTools(opts: {
  getToolSchemas: (namePattern: string) => ToolDef[];
  db?: DbManager;
  serviceManager?: ServiceManager;
  mode?: "blacklist" | "whitelist";
  disabled?: string[];
  enabled?: string[];
}): ToolDef[] {
  const all: ToolDef[] = [
    createToolSearch(opts.getToolSchemas),
    createReadFile(),
    createListDirectory(),
    createWriteFile(),
    createEditFile(),
    createFetchUrl(),
    createA2AListAgents(),
    createA2ASendTask(),
    createA2AGetTaskStatus(),
  ];

  if (opts.db) {
    all.push(
      createSkillList(opts.db),
      createSkillCreate(opts.db),
      createSkillUpdate(opts.db),
      createSkillDelete(opts.db)
    );
  }

  if (opts.serviceManager) {
    all.push(
      createServiceCreate(opts.serviceManager),
      createServiceList(opts.serviceManager),
      createServiceStop(opts.serviceManager),
      createServiceLogs(opts.serviceManager)
    );
  }

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
