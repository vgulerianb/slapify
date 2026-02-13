import fs from "fs";
import path from "path";
import { TaskSession, SessionEvent, TaskStatus } from "./types.js";

const SESSIONS_DIR_NAME = ".slapify/tasks";

function getSessionsDir(): string {
  return path.join(process.cwd(), SESSIONS_DIR_NAME);
}

function ensureSessionsDir(): string {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sessionMetaPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

function sessionEventsPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.jsonl`);
}

export function generateSessionId(): string {
  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 7);
  return `task-${datePart}-${rand}`;
}

export function createSession(goal: string, sessionId?: string): TaskSession {
  ensureSessionsDir();
  const id = sessionId || generateSessionId();
  const now = new Date().toISOString();
  const session: TaskSession = {
    id,
    goal,
    status: "running",
    createdAt: now,
    updatedAt: now,
    iteration: 0,
    memory: {},
    scheduledJobs: [],
  };
  saveSessionMeta(session);
  return session;
}

export function loadSession(sessionId: string): TaskSession | null {
  const metaPath = sessionMetaPath(sessionId);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TaskSession;
  } catch {
    return null;
  }
}

export function saveSessionMeta(session: TaskSession): void {
  ensureSessionsDir();
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    sessionMetaPath(session.id),
    JSON.stringify(session, null, 2)
  );
}

export function appendEvent(sessionId: string, event: SessionEvent): void {
  ensureSessionsDir();
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(sessionEventsPath(sessionId), line);
}

export function loadEvents(sessionId: string): SessionEvent[] {
  const eventsPath = sessionEventsPath(sessionId);
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs
    .readFileSync(eventsPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as SessionEvent;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SessionEvent[];
}

export function listSessions(): TaskSession[] {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(dir, f), "utf-8")
        ) as TaskSession;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        new Date(b!.updatedAt).getTime() - new Date(a!.updatedAt).getTime()
    ) as TaskSession[];
}

export function updateSessionStatus(
  session: TaskSession,
  status: TaskStatus
): void {
  session.status = status;
  saveSessionMeta(session);
}

/**
 * Rebuild the LLM message history from JSONL events.
 * Used when resuming a session.
 */
export function rebuildMessages(
  events: SessionEvent[]
): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];

  for (const event of events) {
    if (event.type === "session_start") {
      messages.push({ role: "user", content: event.goal });
    } else if (event.type === "llm_response") {
      const content: unknown[] = [];
      if (event.text) {
        content.push({ type: "text", text: event.text });
      }
      for (const tc of event.toolCalls) {
        content.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
    } else if (event.type === "tool_call" || event.type === "tool_error") {
      // Collect consecutive tool results into one tool message
      const last = messages[messages.length - 1];
      const resultContent = {
        type: "tool-result",
        toolCallId: (event as { toolCallId?: string }).toolCallId || "",
        toolName: event.toolName,
        result:
          event.type === "tool_error"
            ? `ERROR: ${event.error}`
            : JSON.stringify(event.result),
      };

      if (last && last.role === "tool" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(resultContent);
      } else {
        messages.push({ role: "tool", content: [resultContent] });
      }
    }
  }

  return messages;
}
