# Agent Guidelines — Cognitive Architecture

## DeepSeek Cognitive API Integration

This project implements a **Cognitive Processing Engine** powered by the **DeepSeek API** (via OpenAI-compatible SDK). **Before modifying any cognitive layer code**, you MUST read the relevant DeepSeek official documentation.

### Required Reading List

| Topic | URL | When to read |
|-------|-----|-------------|
| Extended Thinking Mode | https://api-docs.deepseek.com/zh-cn/guides/thinking_mode | Before enabling/modifying reasoning/Chain-of-Thought features |
| Autonomous Tool Calls | https://api-docs.deepseek.com/zh-cn/guides/tool_calls | Before modifying tool calling / autonomous orchestration logic |
| Multi-round Context Management | https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat | Before modifying message history / cognitive context handling |
| Structured Output Mode | https://api-docs.deepseek.com/zh-cn/guides/json_mode | Before adding structured knowledge extraction features |

### Key Implementation Rules

#### 1. Extended Thinking Mode (链式思维推理)
- Must pass `extra_body: { thinking: { type: "enabled" } }` to explicitly enable cognitive reasoning
- Must pass `reasoning_effort: "high"` (or `"max"`) for deep cognitive processing
- If the assistant message contains `tool_calls`, its `reasoning_content` **MUST** be passed back in subsequent requests (maintains reasoning chain continuity)
- If no `tool_calls`, `reasoning_content` can be omitted (will be ignored by API)

#### 2. Autonomous Tool Orchestration (自主工具编排)
- Uses standard OpenAI function calling format (MCP-compatible)
- `assistant` message with `tool_calls` must come **before** `tool` messages in the message array (causal ordering)
- To enable `strict` mode (Beta): use `base_url="https://api.deepseek.com/beta"`, set `strict: true` on all functions, and ensure `additionalProperties: false` + all properties are `required`

#### 3. Multi-round Context Management (多轮认知上下文)
- DeepSeek API is **stateless** — the full cognitive context must be sent with every request
- The backend `toOpenAIMessages()` method handles context compression correctly; do not break it
- Context window: 8000 tokens with adaptive summarization

### Current Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| Extended Thinking parameters | ✅ Done | `extra_body: {thinking: {type: "enabled"}}` and `reasoning_effort` passed when `config.llm.thinking` is true (default) |
| `reasoning_content` persistence | ✅ Done | Saved to `ChatMessage.reasoning_content`, replayed via `toOpenAIMessages()` |
| Tool call message ordering | ✅ Done | Assistant (with tool_calls) → Tool messages (causal chain) |
| Full context per request | ✅ Done | `toOpenAIMessages()` sends complete cognitive history |
| Strict tool mode | ❌ Not supported | `toolDefToOpenAI()` does not emit `strict` or `additionalProperties` |
| Structured output mode | ❌ Not used | Not currently needed for knowledge extraction |

## Cognitive Architecture Principles

1. **Neural Memory Network**: All user-specific knowledge is stored in a hierarchical memory system (Profile → Fact → Lesson)
2. **Adaptive Knowledge Extraction**: Post-session background learning extracts durable knowledge from ephemeral conversations
3. **Context Compression**: When cognitive context exceeds budget, oldest episodic memories are summarized into semantic abstractions
4. **Autonomous Tool Discovery**: Agent dynamically discovers and invokes tools through MCP protocol without hardcoded logic
