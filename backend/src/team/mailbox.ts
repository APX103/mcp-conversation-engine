// ── In-Memory Mailbox ──
// 负责同一 Team 内所有 agent 之间的消息收发
// 同进程内使用纯内存实现，无需文件锁

import { randomUUID } from "crypto";
import type { TeamMessage } from "./types.js";
import { TEAM_MESSAGE_HISTORY_LIMIT } from "./types.js";

export class Mailbox {
  // agentId (or "team-lead") -> ordered message list
  private inboxes = new Map<string, TeamMessage[]>();
  // Track read status: agentId -> Set of message ids
  private readTracker = new Map<string, Set<string>>();

  /**
   * Send a message to a specific recipient's inbox.
   */
  send(recipient: string, message: Omit<TeamMessage, "id" | "timestamp">): TeamMessage {
    const fullMessage: TeamMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    let inbox = this.inboxes.get(recipient);
    if (!inbox) {
      inbox = [];
      this.inboxes.set(recipient, inbox);
    }
    inbox.push(fullMessage);

    // Trim old messages to prevent unbounded growth
    if (inbox.length > TEAM_MESSAGE_HISTORY_LIMIT) {
      const removed = inbox.splice(0, inbox.length - TEAM_MESSAGE_HISTORY_LIMIT);
      // Also clean up read tracker for removed messages
      const readSet = this.readTracker.get(recipient);
      if (readSet) {
        for (const msg of removed) {
          readSet.delete(msg.id);
        }
      }
    }

    return fullMessage;
  }

  /**
   * Broadcast a message to all members' inboxes.
   * Optionally exclude the sender.
   */
  broadcast(
    memberIds: string[],
    message: Omit<TeamMessage, "id" | "timestamp">,
    exclude?: string[]
  ): TeamMessage {
    const fullMessage: TeamMessage = {
      ...message,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    const excludeSet = new Set(exclude ?? []);
    for (const memberId of memberIds) {
      if (excludeSet.has(memberId)) continue;

      let inbox = this.inboxes.get(memberId);
      if (!inbox) {
        inbox = [];
        this.inboxes.set(memberId, inbox);
      }
      inbox.push(fullMessage);

      if (inbox.length > TEAM_MESSAGE_HISTORY_LIMIT) {
        const removed = inbox.splice(0, inbox.length - TEAM_MESSAGE_HISTORY_LIMIT);
        const readSet = this.readTracker.get(memberId);
        if (readSet) {
          for (const msg of removed) readSet.delete(msg.id);
        }
      }
    }

    return fullMessage;
  }

  /**
   * Read all messages in an agent's inbox.
   */
  read(agentId: string): TeamMessage[] {
    return this.inboxes.get(agentId) ?? [];
  }

  /**
   * Read unread messages (not yet marked as read).
   */
  readUnread(agentId: string): TeamMessage[] {
    const inbox = this.inboxes.get(agentId) ?? [];
    const readSet = this.readTracker.get(agentId);
    if (!readSet) return [...inbox];
    return inbox.filter((msg) => !readSet.has(msg.id));
  }

  /**
   * Mark specific messages as read.
   */
  markRead(agentId: string, messageIds: string[]): void {
    let readSet = this.readTracker.get(agentId);
    if (!readSet) {
      readSet = new Set();
      this.readTracker.set(agentId, readSet);
    }
    for (const id of messageIds) {
      readSet.add(id);
    }
  }

  /**
   * Mark all messages in an inbox as read.
   */
  markAllRead(agentId: string): void {
    const inbox = this.inboxes.get(agentId) ?? [];
    let readSet = this.readTracker.get(agentId);
    if (!readSet) {
      readSet = new Set();
      this.readTracker.set(agentId, readSet);
    }
    for (const msg of inbox) {
      readSet.add(msg.id);
    }
  }

  /**
   * Get count of unread messages.
   */
  unreadCount(agentId: string): number {
    return this.readUnread(agentId).length;
  }

  /**
   * Clear an agent's inbox (e.g., on shutdown).
   */
  clearInbox(agentId: string): void {
    this.inboxes.delete(agentId);
    this.readTracker.delete(agentId);
  }

  /**
   * Clear all data (e.g., on team disband).
   */
  clearAll(): void {
    this.inboxes.clear();
    this.readTracker.clear();
  }

  /**
   * Get all member IDs that have inboxes.
   */
  getMemberIds(): string[] {
    return Array.from(this.inboxes.keys());
  }
}
