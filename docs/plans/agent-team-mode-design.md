# Agent Team Mode 架构设计文档

> 基于 Claude Code Agent Team 调研报告，结合 MCP Conversation Engine 现有架构进行适配设计。

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              前端 (React SPA)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │  会话侧边栏  │  │  聊天主区域  │  │  Team 面板   │  │  Agent 执行卡片  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │ SSE / HTTP
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         后端 (Express + TypeScript)                      │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     ConversationEngine (Leader)                  │    │
│  │  ┌──────────────────────────────────────────────────────────┐   │    │
│  │  │  Team Tools: create_team / spawn_teammate / send_message │   │    │
│  │  │          / assign_task / list_members / shutdown         │   │    │
│  │  └──────────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │ spawn                                    │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              TeamManager ── 单例，管理所有 Team                  │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │    │
│  │  │   Mailbox    │  │   TaskBoard  │  │   MemberRegistry     │  │    │
│  │  │  (内存+DB)   │  │  (内存+DB)   │  │   (内存+DB)          │  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │ run (async)                              │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  TeammateEngine × N (每个 worker 一个独立实例，复用 SubagentEngine) │    │
│  │  - 独立 OpenAI 连接  - 独立上下文  - 完整工具集(不含 spawn_agent)   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  EventBus ── 前端 SSE 推送中心                                   │    │
│  │  team_event → /api/team/:teamId/stream                         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 与 Claude Code 的差异

| 维度 | Claude Code (CLI) | MCP Conversation Engine (Web) |
|------|-------------------|-------------------------------|
| 执行后端 | tmux / iTerm2 / in-process | **纯 in-process**（单进程多实例） |
| 通信方式 | 文件系统 Mailbox (`~/.claude/teams/`) | **内存 Mailbox** + MongoDB 持久化 |
| 身份传递 | CLI args (`--agent-id`, `--team-name`) | **运行时对象引用**（engine 实例上下文） |
| UI 展示 | 多 pane 终端布局 | **Web Panel**（侧边栏 + 执行卡片） |
| 权限审批 | 独立 UI dialog + 文件同步 | **通过主会话流统一审批**（Leader 代理） |

---

## 二、核心概念与模型

### 2.1 Team

一个 Team 是 **一个 Session 内的临时协作单元**。当用户发送消息触发 `create_team` 时，在当前 session 中创建 team，session 结束后 team 自动解散。

```typescript
interface Team {
  teamId: string;           // 唯一标识 (team-{uuid})
  name: string;             // 显示名称
  leaderSessionId: string;  // 所属主会话
  status: "active" | "idle" | "shutdown";
  createdAt: number;
  members: Teammate[];
  tasks: TeamTask[];
  metadata: {
    description?: string;
    maxTeammates: number;   // 默认 5
  };
}
```

### 2.2 Teammate (Worker)

每个 teammate 是一个独立运行的 agent 实例，复用现有的 `SubagentEngine`：

```typescript
interface Teammate {
  agentId: string;          // teammate-{name}@{teamId}
  name: string;             // 显示名称，如 "researcher", "coder"
  displayName: string;      // 带颜色的显示名
  color: string;            // 用于 UI 区分的颜色 (tailwind class)
  status: "idle" | "busy" | "completed" | "error" | "shutdown";
  currentTaskId?: string;   // 当前正在执行的任务
  spawnedAt: number;
  completedAt?: number;
  result?: string;          // 最终结果摘要
}
```

**关键约束**：
- Teammate **不能** spawn 其他 teammate（扁平 roster）
- 一个 Leader 同时只能管理 **一个** active team
- 最多 `maxTeammates` 个 teammate（默认 5）

### 2.3 TeamMessage（Mailbox 消息）

```typescript
interface TeamMessage {
  id: string;
  from: string;             // sender agentId 或 "user"
  to: string;               // recipient agentId 或 "*" (broadcast)
  type: TeamMessageType;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

type TeamMessageType =
  | "chat"                  // 普通业务通信
  | "task_assignment"       // 任务分配
  | "task_result"          // 任务完成结果
  | "shutdown_request"     // Leader 请求关闭
  | "shutdown_response"    // Teammate 响应关闭
  | "idle_notification"    // Teammate 空闲通知
  | "tool_permission_request"   // 工具权限请求（teammate → leader）
  | "tool_permission_response"; // 工具权限响应（leader → teammate）
```

### 2.4 TeamTask（共享任务板）

```typescript
interface TeamTask {
  id: string;
  subject: string;          // 任务标题
  description: string;      // 详细描述
  owner?: string;           // 负责执行的 teammate name
  status: "pending" | "in_progress" | "completed" | "failed";
  priority: "low" | "medium" | "high";
  blocks: string[];         // 阻塞的任务 ID 列表
  blockedBy: string[];      // 被阻塞的任务 ID 列表
  createdAt: number;
  completedAt?: number;
  result?: string;          // 执行结果
}
```

---

## 三、后端架构详解

### 3.1 模块结构（新增/修改）

```
backend/src/
├── team/
│   ├── types.ts            # Team, Teammate, TeamMessage, TeamTask 类型
│   ├── manager.ts          # TeamManager 单例：创建/销毁 team，管理成员
│   ├── mailbox.ts          # 内存 Mailbox：send/receive/poll 消息
│   ├── taskboard.ts        # 任务板：CRUD + 依赖检查 + 自动认领
│   ├── engine.ts           # TeammateEngine：复用 SubagentEngine 的包装
│   └── tools.ts            # Team 相关 ToolDef（create_team, spawn_teammate 等）
│
├── subagent/
│   ├── engine.ts           # 修改：支持 team context 注入
│   └── ...                 # 其他文件基本不变
│
├── engine.ts               # 修改：集成 TeamManager，Leader 系统 prompt 注入 team 纪律
├── tools.ts                # 修改：新增 team 工具（或从 team/tools.ts 导入）
├── types.ts                # 修改：新增 Team* 类型
└── index.ts                # 修改：新增 /api/team/* 端点
```

### 3.2 TeamManager（核心协调器）

```typescript
class TeamManager {
  private teams = new Map<string, Team>();           // teamId → Team
  private mailboxes = new Map<string, Mailbox>();    // teamId → Mailbox
  private taskboards = new Map<string, TaskBoard>(); // teamId → TaskBoard
  private engines = new Map<string, TeammateEngine>(); // agentId → Engine
  private eventBus = new EventEmitter();             // 前端 SSE 推送

  // ── Team 生命周期 ──
  createTeam(sessionId: string, name: string, description?: string): Team;
  disbandTeam(teamId: string, reason?: string): Promise<void>;
  getTeamBySession(sessionId: string): Team | undefined;

  // ── Teammate 生命周期 ──
  spawnTeammate(teamId: string, config: TeammateConfig): Promise<Teammate>;
  shutdownTeammate(teamId: string, agentId: string): Promise<void>;
  killTeammate(teamId: string, agentId: string): Promise<void>;

  // ── 通信 ──
  sendMessage(teamId: string, msg: TeamMessage): void;
  getUnreadMessages(teamId: string, agentId: string): TeamMessage[];
  markMessagesRead(teamId: string, agentId: string, messageIds: string[]): void;

  // ── 事件 ──
  onTeamEvent(teamId: string, listener: (event: TeamStreamEvent) => void): void;
  offTeamEvent(teamId: string, listener: Function): void;
}
```

### 3.3 Mailbox（内存通信）

区别于 Claude Code 的文件系统 Mailbox，我们使用**纯内存实现**（同进程内通信不需要文件开销），可选持久化到 MongoDB：

```typescript
class Mailbox {
  private inboxes = new Map<string, TeamMessage[]>(); // agentId → messages

  write(recipient: string, message: TeamMessage): void;
  read(agentId: string): TeamMessage[];
  readUnread(agentId: string): TeamMessage[];
  markRead(agentId: string, messageIds: string[]): void;

  // 广播：写入所有成员的 inbox
  broadcast(message: TeamMessage, exclude?: string[]): void;
}
```

**为什么不需要文件锁？**
- 所有 teammate 都在同一 Node.js 进程内
- 使用单线程 EventLoop，Map 操作是原子的
- 需要并发控制时（如 teammate 自动认领任务），用简单的 `async-mutex` 即可

### 3.4 TeammateEngine（执行引擎）

复用现有的 `SubagentEngine`，但在其上包装一层 team 上下文：

```typescript
class TeammateEngine {
  private subagentEngine: SubagentEngine;
  private teamId: string;
  private agentId: string;
  private abortController = new AbortController();

  async run(initialTask: string, tools: ToolDef[]): AsyncGenerator<TeammateStreamEvent> {
    // 1. 注入 team 系统 prompt（通信纪律、任务认领规则）
    const teamSystemPrompt = this.buildTeamSystemPrompt();

    // 2. 启动子引擎执行初始任务
    const gen = this.subagentEngine.run(this.agentId, initialTask, tools, teamSystemPrompt);

    // 3. 并行启动 inbox 轮询循环
    this.startInboxPoller();

    // 4. 转发所有事件到 team event bus
    for await (const event of gen) {
      this.emitEvent(event);
      yield event;
    }
  }

  private async startInboxPoller() {
    // 每 500ms 检查一次 mailbox
    // 优先级：shutdown_request > leader 消息 > peer 消息 > task 认领
    while (!this.abortController.signal.aborted) {
      const unread = teamManager.getUnreadMessages(this.teamId, this.agentId);
      // ... 处理消息
      await sleep(500);
    }
  }
}
```

### 3.5 Teammate 系统 Prompt

在 Leader 系统 prompt 和 teammate 系统 prompt 中都注入 **Agent Team Communication** 纪律：

**Leader 系统 prompt 追加：**
```
【Team 协调纪律】
你当前正在管理一个 Agent Team。当你需要分配任务给其他 agent 时：
1. 使用 spawn_teammate 工具创建专门的 teammate
2. 使用 assign_task 工具分配具体任务（包含明确的输入和期望输出）
3. 通过 send_message 工具与 teammate 沟通（to: "<name>" 单播，to: "*" 广播）
4. 监控任务板（list_tasks）跟踪进度
5. 当所有任务完成后，主动 disband_team 解散团队

注意：直接在回复中写文本，其他 teammate 是看不到的 —— 必须使用 send_message 工具。
```

**Teammate 系统 prompt 追加：**
```
【Agent Teammate Communication】
IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team:
- Use the send_message tool with to: "<name>" to send messages to specific teammates
- Use the send_message tool with to: "*" sparingly for team-wide broadcasts
- Use the update_task tool to report progress on your assigned task

Just writing a response in text is not visible to others on your team — you MUST use the send_message tool.

【任务认领规则】
1. 检查 inbox 中是否有 leader 分配给你的任务
2. 如果没有分配，检查 task board 中是否有 pending 且未被阻塞的可用任务
3. 使用 assign_task 工具认领任务（设置 owner 为你自己）
4. 任务完成后使用 update_task 标记为 completed，并发送 task_result 消息
```

### 3.6 工具定义（Team 工具集）

新增 8 个 team 工具：

| 工具名 | 调用者 | 功能 |
|--------|--------|------|
| `team_create` | Leader | 创建 team，初始化 mailbox 和 task board |
| `team_disband` | Leader | 解散 team，关闭所有 teammate |
| `team_spawn_teammate` | Leader | 创建并启动一个 teammate |
| `team_send_message` | Leader/Worker | 发送消息（单播/广播） |
| `team_list_members` | Leader/Worker | 查看团队成员和状态 |
| `team_create_task` | Leader/Worker | 创建新任务 |
| `team_assign_task` | Leader/Worker | 认领/分配任务 |
| `team_list_tasks` | Leader/Worker | 查看任务板 |
| `team_update_task` | Leader/Worker | 更新任务状态/结果 |
| `team_shutdown_teammate` | Leader | 请求关闭指定 teammate |

**spawn_agent 的演进**：
- 保留现有 `spawn_agent` 作为简单子 agent 调用（单任务，无通信）
- `team_spawn_teammate` 用于 team 协作场景（多 agent 通信、任务板共享）

### 3.7 API 端点（新增）

```
POST   /api/team/create                # 创建 team（通常由 agent 工具调用，也可手动）
POST   /api/team/:teamId/disband       # 解散 team

POST   /api/team/:teamId/spawn         # 创建 teammate
POST   /api/team/:teamId/shutdown      # 关闭 teammate

POST   /api/team/:teamId/message       # 发送消息
GET    /api/team/:teamId/messages      # 获取消息历史

POST   /api/team/:teamId/task          # 创建任务
GET    /api/team/:teamId/tasks         # 获取任务列表
PATCH  /api/team/:teamId/tasks/:taskId # 更新任务

GET    /api/team/:teamId/stream        # SSE: team 实时事件流
GET    /api/team/:teamId               # 获取 team 完整状态
GET    /api/session/:sessionId/team    # 获取当前 session 的 active team
```

### 3.8 事件流（TeamStreamEvent）

```typescript
type TeamStreamEvent =
  // 团队生命周期
  | { type: "team_created"; teamId: string; name: string }
  | { type: "team_disbanded"; teamId: string; reason?: string }

  // 成员生命周期
  | { type: "teammate_spawned"; agentId: string; name: string; color: string }
  | { type: "teammate_status_changed"; agentId: string; status: TeammateStatus }
  | { type: "teammate_shutdown"; agentId: string; reason?: string }

  // 消息
  | { type: "message"; message: TeamMessage }

  // 任务
  | { type: "task_created"; task: TeamTask }
  | { type: "task_updated"; task: TeamTask }
  | { type: "task_completed"; taskId: string; result: string }

  // 执行事件（透传 teammate 内部事件）
  | { type: "teammate_event"; agentId: string; event: SubagentStreamEvent }

  // 错误
  | { type: "error"; agentId?: string; message: string };
```

---

## 四、前端架构详解

### 4.1 新增/修改文件

```
frontend/src/
├── App.tsx                      # 修改：集成 team 状态管理
├── types.ts                     # 修改：新增 Team* 类型
│
├── components/
│   ├── TeamPanel.tsx            # 新增：Team 侧边栏面板
│   ├── TeammateCard.tsx         # 新增：单个 teammate 状态卡片
│   ├── TaskBoard.tsx            # 新增：任务板组件
│   ├── TeamMessageThread.tsx    # 新增：团队消息线程
│   └── ToolBlocks.tsx           # 修改：AgentBlock 扩展支持 teammate 展示
│
└── hooks/
    └── useTeam.ts               # 新增：Team SSE 连接和状态管理 hook
```

### 4.2 UI 布局变化

当前布局：Sidebar（会话列表） | Main（聊天区域） | Memory Drawer（记忆面板）

Team Mode 布局：

```
┌─────────────────┬────────────────────────────────┬─────────────────┐
│                 │                                │                 │
│   会话侧边栏     │        聊天主区域               │   Team 面板     │
│                 │                                │   (可折叠)      │
│  - 会话列表      │   ┌──────────────────────┐   │                 │
│  - 技能开关      │   │  Agent 执行卡片       │   │  ┌───────────┐ │
│                 │   │  (teammate 实时日志)  │   │  │ teammate 1 │ │
│                 │   └──────────────────────┘   │  │  🟢 busy   │ │
│                 │                                │  ├───────────┤ │
│                 │   ┌──────────────────────┐   │  │ teammate 2 │ │
│                 │   │  消息输入框           │   │  │  🔵 idle   │ │
│                 │   └──────────────────────┘   │  ├───────────┤ │
│                 │                                │  │ TaskBoard │ │
│                 │                                │  │ 3/5 done  │ │
│                 │                                │  └───────────┘ │
└─────────────────┴────────────────────────────────┴─────────────────┘
```

- **Team 面板**默认折叠，当 session 中有 active team 时自动展开
- **TeammateCard** 显示：名称、颜色标识、状态、当前任务、执行进度
- **Agent 执行卡片**（复用现有 AgentBlock）在聊天区域展示 teammate 的实时执行过程
- **TaskBoard** 在 Team 面板内展示共享任务列表

### 4.3 状态管理

在 `App.tsx` 中新增 team 相关状态：

```typescript
// Team 状态
const [team, setTeam] = useState<Team | null>(null);
const [teammates, setTeammates] = useState<Teammate[]>([]);
const [teamMessages, setTeamMessages] = useState<TeamMessage[]>([]);
const [tasks, setTasks] = useState<TeamTask[]>([]);
const [teamPanelOpen, setTeamPanelOpen] = useState(false);

// SSE 连接 team 事件流
useEffect(() => {
  if (!currentSessionId || !team) return;
  const es = new EventSource(`/api/team/${team.teamId}/stream`);
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleTeamEvent(event);
  };
  return () => es.close();
}, [currentSessionId, team?.teamId]);
```

---

## 五、关键时序图

### 5.1 Team 创建与任务分配

```
User          Leader(Engine)    TeamManager    TeammateEngine    Mailbox
 │                 │                │                │               │
 │── 复杂任务 ────▶│                │                │               │
 │                 │                │                │               │
 │                 │── team_create ─▶│                │               │
 │                 │◀─ team ok ─────│                │               │
 │                 │                │                │               │
 │                 │── spawn "coder"─▶│── create ─────▶│               │
 │                 │                │◀─ started ─────│               │
 │                 │                │                │               │
 │                 │── spawn "tester"─▶│── create ─────▶│               │
 │                 │                │◀─ started ─────│               │
 │                 │                │                │               │
 │                 │── create_task ─▶│                │               │
 │                 │── assign_task("coder")────────────▶│               │
 │                 │                │                │               │
 │                 │                │                │── 检查 inbox ──▶│
 │                 │                │                │◀─ task msg ────│
 │                 │                │                │               │
 │                 │                │                │── 执行任务 ─────▶
 │                 │                │                │               │
 │                 │◀─ teammate_event (SSE) ──────────│               │
 │◀── 实时展示 ────│                │                │               │
 │                 │                │                │               │
 │                 │                │                │── 完成 ────────▶│
 │                 │                │                │── send msg ────▶│
 │                 │◀─ message ────────────────────────────────────────│
 │                 │── update_task ─▶│                │               │
 │                 │                │                │               │
```

### 5.2 Teammate 空闲自动认领任务

```
TeammateEngine          Mailbox          TaskBoard
        │                  │                │
        │── 初始任务完成 ───▶│                │
        │                  │                │
        │── send idle_notification ────────▶│
        │                  │                │
        │◀─ 轮询 inbox ────│                │
        │   (无新消息)     │                │
        │                  │                │
        │── 检查 task board ────────────────▶│
        │◀─ pending tasks ──────────────────│
        │                  │                │
        │── assign_task(自己) ──────────────▶│
        │── 开始执行新任务 ──▶│                │
```

---

## 六、数据持久化策略

### 6.1 内存优先，DB 兜底

| 数据 | 存储位置 | 持久化时机 | 说明 |
|------|----------|-----------|------|
| Team 元数据 | 内存 + MongoDB | 创建/更新时 | 用于 session 恢复 |
| Teammate 状态 | 内存 + MongoDB | 状态变更时 | 用于前端展示 |
| Mailbox 消息 | 内存 + MongoDB | 每条消息写入 | 完整通信历史 |
| TaskBoard | 内存 + MongoDB | 任务变更时 | 任务状态同步 |
| Teammate 执行日志 | MongoDB (SubagentDB) | 实时写入 | 复用现有 subagent 表 |

### 6.2 集合设计（MongoDB）

```javascript
// teams 集合
db.teams.insert({
  _id: "team-xxx",
  name: "Research Squad",
  leaderSessionId: "session-xxx",
  status: "active",
  members: [...],
  tasks: [...],
  createdAt: ISODate(),
});

// team_messages 集合（按 teamId 分片索引）
db.team_messages.insert({
  teamId: "team-xxx",
  from: "team-lead",
  to: "researcher",
  type: "task_assignment",
  content: "...",
  timestamp: ISODate(),
});

// teammates 复用 subagents 集合，增加 teamId 字段
```

---

## 七、安全与约束

### 7.1 沙箱约束

- Teammate 不能调用 `spawn_agent` 或 `team_spawn_teammate`（防止无限递归）
- Teammate 不能调用 `team_disband`（只有 Leader 可以）
- Teammate 只能发送消息给同 team 的成员

### 7.2 资源约束

- 最大 teammate 数量：5（可配置）
- 每个 teammate 最大执行时间：5 分钟（复用 SubagentEngine 超时）
- 总 team 最大存活时间：30 分钟（自动清理孤儿 team）

### 7.3 权限审批简化

与 Claude Code 不同，我们的 teammate 运行在同一进程中，**不需要跨进程权限同步**：
- Teammate 的工具调用直接由 `TeammateEngine` 执行
- 敏感操作（如写文件、删除）的审批通过 `tool_permission_request` 消息发送给 Leader
- Leader 在下一轮 LLM 调用中收到消息，使用 `tool_permission_response` 回复
- 对于非敏感操作，可以配置自动放行（blacklist/whitelist 模式）

---

## 八、实现路线图

### Phase 1: 核心基础设施（1-2 天）

- [ ] 创建 `backend/src/team/` 目录结构
- [ ] 定义 `team/types.ts`（Team, Teammate, TeamMessage, TeamTask, TeamStreamEvent）
- [ ] 实现 `team/mailbox.ts`（内存 Mailbox）
- [ ] 实现 `team/taskboard.ts`（任务板）
- [ ] 实现 `team/manager.ts`（TeamManager 单例）
- [ ] 扩展 `backend/src/types.ts` 添加 Team 类型

### Phase 2: 执行引擎与工具（2-3 天）

- [ ] 实现 `team/engine.ts`（TeammateEngine）
- [ ] 修改 `subagent/engine.ts` 支持 team context 注入
- [ ] 实现 `team/tools.ts`（10 个 team 工具）
- [ ] 修改 `engine.ts` 集成 TeamManager
- [ ] 修改 `tools.ts` 注册 team 工具（Leader 可用）
- [ ] Leader 系统 prompt 注入 team 纪律

### Phase 3: API 与事件流（1-2 天）

- [ ] 新增 `/api/team/*` 端点（`backend/src/index.ts`）
- [ ] 实现 Team SSE stream（`/api/team/:teamId/stream`）
- [ ] 集成 TeamManager 事件到 EventBus
- [ ] 测试 API 端到端

### Phase 4: 前端 UI（2-3 天）

- [ ] 扩展 `frontend/src/types.ts`
- [ ] 实现 `useTeam.ts` hook（SSE 连接）
- [ ] 实现 `TeamPanel.tsx`（侧边栏面板）
- [ ] 实现 `TeammateCard.tsx`（成员卡片）
- [ ] 实现 `TaskBoard.tsx`（任务板）
- [ ] 修改 `App.tsx` 集成 team 状态
- [ ] 修改 `ToolBlocks.tsx` AgentBlock 支持 teammate 展示

### Phase 5: 集成测试与优化（1-2 天）

- [ ] 端到端测试：创建 team → spawn teammate → 分配任务 → 完成任务 → 解散 team
- [ ] 并发测试：多个 teammate 同时运行
- [ ] 异常测试：teammate 超时、错误处理、孤儿 team 清理
- [ ] 性能优化：inbox 轮询频率、内存泄漏检查

---

## 九、风险与决策记录

### 决策 1: 内存 Mailbox vs 文件 Mailbox

**选择内存 Mailbox**，原因：
- 所有 agent 都在同一 Node.js 进程内
- 文件 I/O + 锁机制在这个场景下是过度设计
- 内存通信延迟更低（< 1ms vs 文件 IO 的 5-10ms）
- 可选 MongoDB 持久化满足审计需求

### 决策 2: 复用 SubagentEngine vs 新建 TeammateEngine

**复用 SubagentEngine + 包装层**，原因：
- SubagentEngine 已经是一个完整的独立 agent 执行器
- 复用可以减少代码重复，保持行为一致性
- 包装层只负责 team 特有逻辑（inbox 轮询、team prompt 注入）

### 决策 3: Team 绑定 Session vs 独立生命周期

**Team 绑定 Session**，原因：
- 与当前项目模型一致（会话为中心）
- session 结束时自动清理所有资源
- 简化状态管理，避免孤儿 team

### 决策 4: Leader 工具审批机制

**异步消息审批**，原因：
- 同一进程内不需要文件同步
- Leader 的 LLM 循环天然适合处理审批消息
- 实现简单：teammate 发送 `tool_permission_request` → Leader 下一轮收到 → 发送 `tool_permission_response`

---

## 十、参考

- [Claude Code Agent Team 调研报告](../../note/claude_code_agent_team_architecture.html)
- [DeepSeek API 文档 - 工具调用](https://api-docs.deepseek.com/zh-cn/guides/tool_calls)
- [DeepSeek API 文档 - 多轮上下文](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat)
