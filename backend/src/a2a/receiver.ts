/**
 * A2A Receiver — makes the MCP backend act as an A2A agent.
 *
 * Exposes:
 *   GET  /.well-known/agent.json    → Agent Card
 *   POST /tasks/send                → Receive a task (async processing)
 *   GET  /tasks/get?taskId=xxx      → Query task status
 *   POST /tasks/cancel              → Cancel a task
 *
 * On startup, auto-registers with A2A-center and saves agent_id + token.
 */

import type { Express, Request, Response } from "express";
import type { ConversationEngine } from "../engine.js";
import type { DbManager } from "../db.js";

interface A2APart {
  type?: string;
  kind?: string;
  text?: string;
  [key: string]: any;
}

interface A2AMessage {
  messageId?: string;
  role?: string;
  parts?: A2APart[];
  metadata?: Record<string, any>;
}

interface A2AStatus {
  state: string;
  timestamp: string;
  message?: A2AMessage;
}

interface A2ATask {
  id: string;
  sessionId?: string;
  contextId?: string;
  status: A2AStatus;
  history?: A2AMessage[];
  artifacts?: any[];
  metadata?: Record<string, any>;
}

interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransition?: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description?: string;
    tags: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  authentication?: {
    scheme: string;
    scopes?: string[];
  };
}

export class A2AReceiver {
  private tasks = new Map<string, A2ATask>();
  private agentId?: string;
  private token?: string;
  private centerUrl: string;
  private agentUrl: string;
  private engine: ConversationEngine;
  private db?: DbManager;
  private userId = "a2a-agent";

  constructor(opts: {
    centerUrl: string;
    agentUrl: string;
    engine: ConversationEngine;
    db?: DbManager;
  }) {
    this.centerUrl = opts.centerUrl;
    this.agentUrl = opts.agentUrl;
    this.engine = opts.engine;
    this.db = opts.db;
  }

  /** Mount A2A routes on the Express app */
  mount(app: Express) {
    app.get("/.well-known/agent.json", (_req: Request, res: Response) => {
      res.json(this.buildAgentCard());
    });

    app.post("/tasks/send", (req: Request, res: Response) => {
      const task = req.body as A2ATask;
      if (!task || !task.id) {
        res.status(400).json({ error: "invalid_request", message: "Task ID is required" });
        return;
      }

      // Store immediately with working state (A2A-center expects us to process it)
      const storedTask: A2ATask = {
        ...task,
        status: { state: "working", timestamp: new Date().toISOString() },
      };
      this.tasks.set(task.id, storedTask);

      // Acknowledge receipt immediately; processing is async
      res.status(202).json(storedTask);

      // Process asynchronously
      this.processTask(storedTask).catch((err) => {
        console.error(`[A2A] Failed to process task ${task.id}:`, err);
      });
    });

    app.get("/tasks/get", (req: Request, res: Response) => {
      const taskId = req.query.taskId as string;
      if (!taskId) {
        res.status(400).json({ error: "invalid_request", message: "taskId query parameter is required" });
        return;
      }
      const task = this.tasks.get(taskId);
      if (!task) {
        res.status(404).json({ error: "task_not_found", message: "Task not found" });
        return;
      }
      res.json(task);
    });

    app.post("/tasks/cancel", (req: Request, res: Response) => {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: "invalid_request", message: "id is required" });
        return;
      }
      const task = this.tasks.get(id);
      if (!task) {
        res.status(404).json({ error: "task_not_found", message: "Task not found" });
        return;
      }
      task.status = { state: "canceled", timestamp: new Date().toISOString() };
      res.json(task);
    });
  }

  /** Register this agent with A2A-center */
  async register() {
    try {
      const card = this.buildAgentCard();
      const res = await fetch(`${this.centerUrl}/v1/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[A2A] Registration failed: HTTP ${res.status}`, text);
        return;
      }

      const data = await res.json();
      this.agentId = data.agent_id as string;
      this.token = data.token as string;

      // Export credentials so built-in tools can use them
      process.env.A2A_AGENT_ID = this.agentId;
      process.env.A2A_AGENT_TOKEN = this.token;

      console.log(`[A2A] Registered with A2A-center`);
      console.log(`[A2A]   agent_id: ${this.agentId}`);
      console.log(`[A2A]   token:    ${this.token?.slice(0, 8)}...`);
      console.log(`[A2A]   url:      ${this.agentUrl}`);
    } catch (err: any) {
      console.error("[A2A] Registration error:", err.message);
    }
  }

  private buildAgentCard(): AgentCard {
    return {
      name: "MCP Conversation Agent",
      description:
        "An AI agent powered by MCP Conversation Engine. Receives A2A tasks, processes them using LLM reasoning and available tools, and pushes results back.",
      url: this.agentUrl,
      version: "1.0.0",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransition: true,
      },
      skills: [
        {
          id: "general-chat",
          name: "General Chat",
          description: "Process general conversational tasks via LLM",
          tags: ["chat", "nlp", "conversation"],
        },
        {
          id: "tool-use",
          name: "Tool Use",
          description: "Use available MCP tools to accomplish tasks",
          tags: ["tools", "automation", "mcp"],
        },
      ],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
    };
  }

  private async processTask(task: A2ATask) {
    console.log(`[A2A] Processing task ${task.id}...`);

    try {
      // 1. Create a backend session
      let sessionId: string;
      if (this.db) {
        sessionId = await this.db.createSession(this.userId, `A2A Task ${task.id}`);
      } else {
        sessionId = crypto.randomUUID();
      }
      this.engine.getOrCreateSession(sessionId);

      // 2. Extract the first user message from task history
      const firstMessage = task.history?.[0];
      const textPart = firstMessage?.parts?.find(
        (p: A2APart) => p.type === "text" || p.kind === "text"
      );
      const text = textPart?.text || "";

      if (!text) {
        throw new Error("Task message contains no text part");
      }

      // 3. Run the conversation engine
      let reply = "";
      for await (const event of this.engine.run(text, sessionId, this.userId)) {
        if (event.type === "text") {
          reply += event.content;
        }
        // We could also stream partial results back to A2A-center here,
        // but for simplicity we collect the full response.
      }

      // 4. Save session
      await this.engine.saveSession(sessionId);

      // 5. Update task as completed
      task.status = { state: "completed", timestamp: new Date().toISOString() };
      task.artifacts = [
        {
          name: "result",
          parts: [{ type: "text", text: reply }],
        },
      ];

      console.log(`[A2A] Task ${task.id} completed. Reply length: ${reply.length}`);

      // 6. Push result to A2A-center
      await this.pushResult(task);
    } catch (err: any) {
      console.error(`[A2A] Task ${task.id} failed:`, err.message);
      task.status = { state: "failed", timestamp: new Date().toISOString() };
      await this.pushResult(task);
    }
  }

  private async pushResult(task: A2ATask) {
    if (!this.agentId || !this.token) {
      console.warn("[A2A] Cannot push result: not registered with center");
      return;
    }

    try {
      const res = await fetch(`${this.centerUrl}/v1/tasks/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Id": this.agentId,
          "X-Token": this.token,
        },
        body: JSON.stringify(task),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[A2A] Push failed: HTTP ${res.status}`, text);
        return;
      }

      console.log(`[A2A] Pushed result for task ${task.id} (state=${task.status.state})`);
    } catch (err: any) {
      console.error(`[A2A] Push error for task ${task.id}:`, err.message);
    }
  }
}
