export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  result: string | null;
  schema_json: string | null;
  max_steps: number;
  created_at: number;
  updated_at: number;
  prompt_tokens: number;
  completion_tokens: number;
  step_count: number;
  resume_count: number;
  memory_refs_json: string | null;
  has_conversation: 0 | 1;
  message_count: number;
}

export interface TaskDocumentMeta {
  name: string;
  size: number;
}

export interface Step {
  step_index: number;
  kind: "thought" | "tool_call" | "tool_result" | "final" | "error" | "system" | "user";
  content: string;
  created_at: number;
}

export interface TaskMessage {
  id: number;
  role: string;
  content: string;
  created_at: number;
}

export interface MemoryRef {
  type: "task" | "memory";
  id: string;
  title: string;
  score: number;
}

export interface MemoryItem {
  id: string;
  topic_id: string | null;
  topic_path: string | null;
  kind: string;
  title: string;
  content: string;
  source_task_id: string | null;
  pinned: number;
  use_count: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface EpisodeItem {
  task_id: string;
  goal: string;
  outcome: "completed" | "failed";
  summary: string;
  tags: string;
  tools: string;
  step_count: number;
  tokens: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryResponse {
  memories: MemoryItem[];
  episodes: EpisodeItem[];
  stats: { facts: number; topics: number; episodes: number };
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  listTasks: () => fetch("/api/tasks", { cache: "no-store" }).then((r) => j<Task[]>(r)),

  getTask: (id: string) =>
    fetch(`/api/tasks/${id}`, { cache: "no-store" }).then((r) =>
      j<{ task: Task; steps: Step[]; documents: TaskDocumentMeta[] }>(r)
    ),

  createTask: (
    goal: string,
    max_steps?: number,
    json_schema?: object | null,
    documents?: { name: string; content: string }[]
  ) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, max_steps, json_schema, documents }),
    }).then((r) => j<{ id: string; status: string; max_steps: number }>(r)),

  cancelTask: (id: string) =>
    fetch(`/api/tasks/${id}/cancel`, { method: "POST" }).then((r) => j<{ status: string }>(r)),

  resumeTask: (id: string) =>
    fetch(`/api/tasks/${id}/resume`, { method: "POST" }).then((r) => j<{ status: string }>(r)),

  sendMessage: (id: string, content: string) =>
    fetch(`/api/tasks/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).then((r) => j<{ status: string; mode: "steering" | "queued" }>(r)),

  getSettings: () => fetch("/api/settings", { cache: "no-store" }).then((r) => j<Record<string, string>>(r)),

  updateSettings: (values: Record<string, unknown>) =>
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    }).then((r) => j<Record<string, string>>(r)),

  memory: (q = "") =>
    fetch(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" }).then((r) =>
      j<MemoryResponse>(r)
    ),

  setMemoryPinned: (id: string, pinned: boolean) =>
    fetch("/api/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, pinned }),
    }).then((r) => j<{ ok: true }>(r)),

  deleteMemoryItem: (type: "memory" | "episode", id: string) =>
    fetch(`/api/memory?type=${type}&id=${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
      j<{ ok: true }>(r)
    ),
};

export function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
