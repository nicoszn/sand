export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
}

export interface Step {
  step_index: number;
  kind: "thought" | "tool_call" | "tool_result" | "final" | "error" | "system";
  content: string;
  created_at: number;
}

export interface ApiKey {
  id: string;
  label: string;
  key_preview: string;
  enabled: boolean;
  daily_limit: number;
  minute_limit: number;
  requests_today: number;
  requests_remaining_today: number;
  prompt_tokens_today: number;
  completion_tokens_today: number;
  status: "available" | "exhausted" | "disabled";
}

export interface PoolSummary {
  total_keys: number;
  available_keys: number;
  requests_remaining_today: number;
  requests_capacity_today: number;
  tokens_used_today: number;
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
    fetch(`/api/tasks/${id}`, { cache: "no-store" }).then((r) => j<{ task: Task; steps: Step[] }>(r)),

  createTask: (goal: string, max_steps?: number, json_schema?: object | null) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, max_steps, json_schema }),
    }).then((r) => j<{ id: string; status: string; max_steps: number }>(r)),

  cancelTask: (id: string) =>
    fetch(`/api/tasks/${id}/cancel`, { method: "POST" }).then((r) => j<{ status: string }>(r)),

  listKeys: () => fetch("/api/keys", { cache: "no-store" }).then((r) => j<ApiKey[]>(r)),

  addKey: (label: string, key_value: string, daily_limit: number, minute_limit: number) =>
    fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, key_value, daily_limit, minute_limit }),
    }).then((r) => j<{ id: string }>(r)),

  deleteKey: (id: string) => fetch(`/api/keys/${id}`, { method: "DELETE" }).then((r) => j(r)),

  setKeyEnabled: (id: string, enabled: boolean) =>
    fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).then((r) => j(r)),

  poolSummary: () => fetch("/api/pool", { cache: "no-store" }).then((r) => j<PoolSummary>(r)),

  getSettings: () => fetch("/api/settings", { cache: "no-store" }).then((r) => j<Record<string, string>>(r)),

  updateSettings: (values: Record<string, unknown>) =>
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    }).then((r) => j<Record<string, string>>(r)),
};

export function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export const statusColor: Record<TaskStatus, string> = {
  queued: "var(--text-2)",
  running: "var(--accent-amber)",
  completed: "var(--accent-green)",
  failed: "var(--accent-red)",
  cancelled: "var(--text-2)",
};
