import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDef, McpServerConfig } from "./types.js";

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  toolNames: string[];
}

function toolDefFromMcp(serverName: string, tool: {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}): ToolDef {
  const schema = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);

  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    parameters: Object.entries(schema).map(([key, val]: [string, any]) => ({
      name: key,
      type: (val.type as ToolDef["parameters"][0]["type"]) ?? "string",
      description: val.description ?? "",
      required: required.has(key),
    })),
    execute: async (args) => {
      // Will be overwritten after connection setup
      return JSON.stringify({ error: "Not connected" });
    },
  };
}

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private toolDefs = new Map<string, ToolDef>();
  private toolExecuteMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [serverName, conf] of Object.entries(servers)) {
      await this.connect(serverName, conf);
    }
  }

  private async connect(serverName: string, conf: McpServerConfig): Promise<void> {
    if (conf.transport === "http" || conf.transport === "sse") {
      const transport = new StreamableHTTPClientTransport(
        new URL(conf.url!),
        { requestInit: { headers: conf.headers } },
      );
      await this.connectClient(serverName, transport);
      return;
    }

    const transport = new StdioClientTransport({
      command: conf.command!,
      args: conf.args,
    });
    await this.connectClient(serverName, transport);
  }

  private async connectClient(
    serverName: string,
    transport: StdioClientTransport | StreamableHTTPClientTransport,
  ): Promise<void> {

    const client = new Client({ name: "mcp-conversation-engine", version: "1.0.0" });
    await client.connect(transport);

    const toolsList = await client.listTools();
    const toolNames: string[] = [];

    for (const tool of toolsList.tools) {
      const def = toolDefFromMcp(serverName, tool);
      const fullName = def.name;

      // Set up actual executor
      this.toolExecuteMap.set(fullName, async (args) => {
        try {
          const result = await client.callTool({ name: tool.name, arguments: args });
          if (result.isError) return `Error: ${JSON.stringify(result.content)}`;
          return (result.content as { type: string; text?: string }[])
            .map((c: { type: string; text?: string }) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } catch (err: any) {
          return `Error calling ${fullName}: ${err.message}`;
        }
      });

      this.toolDefs.set(fullName, def);
      toolNames.push(fullName);
    }

    this.connections.set(serverName, { client, transport, toolNames });
    console.log(`[MCP] Connected to ${serverName}: ${toolNames.join(", ")}`);
  }

  /** Get all tool definitions with full schemas for LLM */
  getAllTools(): ToolDef[] {
    return [...this.toolDefs.values()];
  }

  /** Get full tool definitions matching a name pattern */
  getFullTools(namePattern: string): ToolDef[] {
    const lower = namePattern.toLowerCase();
    return [...this.toolDefs.values()].filter((t) => t.name.toLowerCase().includes(lower));
  }

  /** Execute a tool by full name */
  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const executor = this.toolExecuteMap.get(name);
    if (!executor) return `Error: Unknown tool "${name}"`;
    return executor(args);
  }

  async disconnectAll(): Promise<void> {
    for (const [, conn] of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.toolDefs.clear();
    this.toolExecuteMap.clear();
  }
}
