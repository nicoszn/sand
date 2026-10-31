export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TaskRow {
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

export type StepKind = "thought" | "tool_call" | "tool_result" | "final" | "error" | "system";

export interface StepRow {
  step_index: number;
  kind: StepKind;
  content: string;
  created_at: number;
}

export interface ApiKeyRow {
  id: string;
  label: string;
  key_value: string;
  daily_limit: number;
  minute_limit: number;
  enabled: number;
  created_at: number;
}

export interface ApiKeyView {
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
