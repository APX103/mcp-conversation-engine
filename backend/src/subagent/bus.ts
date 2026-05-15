import { EventEmitter } from "events";

/**
 * Global event bus for real-time subagent event streaming.
 * Used to bridge SubagentEngine events to frontend SSE consumers.
 */
export const subagentBus = new EventEmitter();
