# Agent Guidelines

## DeepSeek API Integration

This project uses the **DeepSeek API** as its LLM backend (via OpenAI-compatible SDK). **Before modifying any LLM-related code**, you MUST read the relevant DeepSeek official documentation.

### Required Reading List

| Topic | URL | When to read |
|-------|-----|-------------|
| Thinking Mode | https://api-docs.deepseek.com/zh-cn/guides/thinking_mode | Before enabling/modifying reasoning/thinking features |
| Tool Calls | https://api-docs.deepseek.com/zh-cn/guides/tool_calls | Before modifying tool calling / function calling logic |
| Multi-round Chat | https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat | Before modifying message history / context handling |
| JSON Mode | https://api-docs.deepseek.com/zh-cn/guides/json_mode | Before adding structured JSON output features |

### Key Implementation Rules

#### 1. Thinking Mode
- Must pass `extra_body: { thinking: { type: "enabled" } }` to explicitly enable thinking
- Must pass `reasoning_effort: "high"` (or `"max"`)
- If the assistant message contains `tool_calls`, its `reasoning_content` **MUST** be passed back in subsequent requests
- If no `tool_calls`, `reasoning_content` can be omitted (will be ignored by API)

#### 2. Tool Calls
- Uses standard OpenAI function calling format (compatible)
- `assistant` message with `tool_calls` must come **before** `tool` messages in the message array
- To enable `strict` mode (Beta): use `base_url="https://api.deepseek.com/beta"`, set `strict: true` on all functions, and ensure `additionalProperties: false` + all properties are `required`

#### 3. Multi-round Chat
- DeepSeek API is **stateless** — the full conversation history must be sent with every request
- The backend `toOpenAIMessages()` method handles this correctly; do not break it

### Current Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| Thinking mode parameters | ✅ Done | `extra_body: {thinking: {type: "enabled"}}` and `reasoning_effort` passed when `config.llm.thinking` is true (default) |
| `reasoning_content` save & replay | ✅ Done | Saved to `ChatMessage.reasoning_content`, replayed via `toOpenAIMessages()` |
| Tool call message ordering | ✅ Done | Assistant (with tool_calls) → Tool messages |
| Full history per request | ✅ Done | `toOpenAIMessages()` sends complete history |
| Strict tool mode | ❌ Not supported | `toolDefToOpenAI()` does not emit `strict` or `additionalProperties` |
| JSON mode | ❌ Not used | Not currently needed |
