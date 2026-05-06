/**
 * A2A SDK wrapper for MCP Conversation Engine backend.
 *
 * Provides thin helpers around @a2a-js/sdk so that:
 * - The backend can act as an A2A client (discover agents, send tasks).
 * - Agent-created dynamic services can import these helpers via the same node_modules.
 */

import {
  A2AClient,
  type A2AClientOptions,
  DefaultAgentCardResolver,
} from "@a2a-js/sdk/client";

export { A2AClient, type A2AClientOptions, DefaultAgentCardResolver };

/**
 * Resolve an agent card from a base URL.
 */
export async function resolveAgentCard(baseUrl: string): Promise<import("@a2a-js/sdk").AgentCard> {
  const resolver = new DefaultAgentCardResolver();
  return resolver.resolve(baseUrl);
}

/**
 * Create an A2A HTTP client from a remote agent card URL.
 * Example: createA2AClient("http://a2a-center:8888")
 */
export async function createA2AClient(
  agentCardUrl: string,
  opts?: A2AClientOptions
): Promise<A2AClient> {
  return A2AClient.fromCardUrl(agentCardUrl, opts);
}

/**
 * Build a text Message for the A2A protocol.
 */
export function buildTextMessage(text: string): import("@a2a-js/sdk").Message {
  return {
    kind: "message",
    messageId: crypto.randomUUID(),
    parts: [{ kind: "text", text }],
  } as import("@a2a-js/sdk").Message;
}

/**
 * Send a single (non-streaming) text task to an A2A agent.
 * Returns the completed task or direct message response.
 */
export async function sendTextTask(
  client: A2AClient,
  text: string
): Promise<import("@a2a-js/sdk").SendMessageResponse> {
  return client.sendMessage({
    message: buildTextMessage(text),
  });
}

/**
 * Send a streaming text task to an A2A agent.
 * Yields each stream event so callers can consume partial results.
 */
export async function* streamTextTask(
  client: A2AClient,
  text: string
): AsyncGenerator<any, void, unknown> {
  const stream = await client.sendMessageStream({
    message: buildTextMessage(text),
  });

  for await (const event of stream) {
    yield event;
  }
}
