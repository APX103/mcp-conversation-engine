import type { ToolDef } from "./types.js";

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

export function createBuiltinTools(opts: {
  getToolSchemas: (namePattern: string) => ToolDef[];
}): ToolDef[] {
  return [createToolSearch(opts.getToolSchemas)];
}
