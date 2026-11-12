/**
 * The agent loop: plan -> call model -> run a tool -> feed result back ->
 * repeat, until the model calls finish(), an unrecoverable error occurs, or
 * the step/token cap is hit. Every step is persisted immediately so the UI
 * (or nothing at all) can observe progress at any time.
 *
 * There is exactly one model and one key (both from `config`), so there is no
 * per-model retry ladder here - a failed call is reported and the task stops.
 */
import { getDb, now, tokensUsedToday } from "./db";
import { getSettingInt } from "./settingsStore";
import { TOOL_SCHEMAS, TOOL_FUNCTIONS } from "./tools";
import { chatCompletion, ChatMessage } from "./openrouterClient";
import { config } from "@/lib/config";
import { renderDocumentsForPrompt } from "./documents";
import { StepKind } from "./types";

export interface ResumeState {
  messages: ChatMessage[];
  fromStep: number;
}

const SYSTEM_PROMPT = `You are an autonomous task-completing agent running in a sandbox.
You have tools to search the web, fetch pages, and run Python or JavaScript code.
Work step by step. Call one tool at a time. When you have enough information to
answer, or if the task is impossible, call the \`finish\` tool with success=true/false
and your answer. Be concise in your reasoning. Do not call finish until you have
actually gathered the information needed.`;

function logStep(taskId: string, index: number, kind: StepKind, content: string) {
  const db = getDb();
  db.prepare("INSERT INTO steps (task_id, step_index, kind, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    index,
    kind,
    content,
    now()
  );
  db.prepare("UPDATE tasks SET step_count = ?, updated_at = ? WHERE id = ?").run(index, now(), taskId);
}

function updateTask(taskId: string, fields: Record<string, unknown>) {
  const db = getDb();
  const sets = Object.keys(fields)
    .map((k) => `${k} = ?`)
    .join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), now(), taskId);
}

function addTokens(taskId: string, promptTokens: number, completionTokens: number) {
  getDb()
    .prepare(
      "UPDATE tasks SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ? WHERE id = ?"
    )
    .run(promptTokens, completionTokens, taskId);
}

function isCancelled(taskId: string): boolean {
  const row = getDb().prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
  return row?.status === "cancelled";
}

function persistConversation(taskId: string, messages: ChatMessage[]) {
  getDb().prepare("UPDATE tasks SET conversation_json = ? WHERE id = ?").run(JSON.stringify(messages), taskId);
}

export async function runTask(
  taskId: string,
  goal: string,
  maxSteps: number,
  jsonSchema: Record<string, unknown> | null,
  resume?: ResumeState
) {
  const dailyBudget = getSettingInt("daily_token_budget", 200000);

  let messages: ChatMessage[];
  let startStep: number;

  if (resume) {
    messages = resume.messages;
    startStep = resume.fromStep + 1;
    logStep(taskId, resume.fromStep, "system", `Resumed after a restart (${messages.length} messages carried over).`);
  } else {
    messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: goal },
    ];
    if (jsonSchema) {
      messages[0].content += `\nWhen you call finish, the \`answer\` field must be a JSON string matching this schema: ${JSON.stringify(
        jsonSchema
      )}`;
    }
    const docContext = renderDocumentsForPrompt(taskId);
    if (docContext) {
      messages.push({ role: "user", content: docContext });
    }
    startStep = 1;
    logStep(taskId, 0, "system", `Task started. model=${config.model} max_steps=${maxSteps}`);
  }

  updateTask(taskId, { status: "running" });

  for (let step = startStep; step <= maxSteps; step++) {
    if (isCancelled(taskId)) {
      logStep(taskId, step, "system", "Task was cancelled.");
      return;
    }

    if (tokensUsedToday() >= dailyBudget) {
      logStep(taskId, step, "error", "Daily token budget reached. Pausing task.");
      updateTask(taskId, { status: "failed", result: "Stopped: daily token budget exhausted." });
      return;
    }

    let response;
    try {
      response = await chatCompletion(messages, TOOL_SCHEMAS, 1500);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logStep(taskId, step, "error", `Model call failed: ${message}`);
      updateTask(taskId, { status: "failed", result: `Stopped: ${message}` });
      return;
    }

    addTokens(taskId, response.usage.prompt_tokens ?? 0, response.usage.completion_tokens ?? 0);

    const msg = response.message;
    messages.push(msg);
    persistConversation(taskId, messages);

    const reasoningText = msg.content ?? "";
    if (reasoningText) logStep(taskId, step, "thought", reasoningText);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      logStep(taskId, step, "final", reasoningText || "[empty response]");
      updateTask(taskId, { status: "completed", result: reasoningText });
      return;
    }

    let finished = false;
    for (const call of toolCalls) {
      const fnName = call.function.name;
      let fnArgs: Record<string, unknown> = {};
      try {
        fnArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
        fnArgs = {};
      }

      logStep(taskId, step, "tool_call", JSON.stringify({ tool: fnName, args: fnArgs }));

      if (fnName === "finish") {
        const success = fnArgs.success !== false;
        const answer = typeof fnArgs.answer === "string" ? fnArgs.answer : JSON.stringify(fnArgs.answer ?? "");
        logStep(taskId, step, "final", answer);
        updateTask(taskId, { status: success ? "completed" : "failed", result: answer });
        finished = true;
        break;
      }

      const toolFn = TOOL_FUNCTIONS[fnName];
      let resultText: string;
      if (!toolFn) {
        resultText = `Unknown tool: ${fnName}`;
      } else {
        try {
          resultText = await toolFn(fnArgs);
        } catch (e) {
          resultText = `Tool error: ${e instanceof Error ? e.message : e}`;
        }
      }

      logStep(taskId, step, "tool_result", resultText);
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      persistConversation(taskId, messages);
    }

    if (finished) return;
  }

  logStep(taskId, maxSteps, "error", "Max step count reached without finishing.");
  updateTask(taskId, { status: "failed", result: "Stopped: reached the step cap without finishing." });
}
