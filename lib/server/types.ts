export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

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
  conversation_json: string | null;
  resume_count: number;
}

export interface TaskDocument {
  id: string;
  task_id: string;
  name: string;
  content: string;
  created_at: number;
}

export type StepKind = "thought" | "tool_call" | "tool_result" | "final" | "error" | "system";

export interface StepRow {
  step_index: number;
  kind: StepKind;
  content: string;
  created_at: number;
}
