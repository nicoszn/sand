/**
 * The agent loop: plan -> call model -> run a tool -> feed result back ->
 * repeat, until the model calls finish(), an unrecoverable error occurs, or
 * the step/token cap is hit. Every step is persisted immediately so the UI
 * (or nothing at all) can observe progress at any time.
 *
 * One task can span several turns: a person may send follow-up messages while
 * it runs (steering) or after it has finished (continuing the conversation).
 * `max_steps` is a per-turn ceiling, so a long conversation never gets stuck
 * at its first cap. Unseen messages are claimed with `takePendingMessages`,
 * which also survives a restart without losing input.
 */
import { getDb, tokensUsedToday } from "./db";
import { getSettingInt } from "./settingsStore";
import { TOOL_SCHEMAS, TOOL_FUNCTIONS } from "./tools";
import { chatCompletion, ChatMessage } from "./openrouterClient";
import { config } from "@/lib/config";
import { renderDocumentsForPrompt } from "./documents";
import { buildMemoryContext } from "./memory";
import { takePendingMessages } from "./messages";
import { addTokens, logStep, updateTask } from "./events";

export interface TurnState {
  messages: ChatMessage[];
  fromStep: number;
  reason: "resume" | "followup";
}

const MAX_TURNS = 25;

/** Older tool output is shortened when a conversation continues, because the
 * full text is already in the task's activity log. Everything is resent to the
 * model on every step, so this is the difference between a follow-up costing a
 * few hundred prompt tokens and a few thousand. */
const KEEP_RECENT_TOOL_RESULTS = 2;
const TOOL_STUB_CHARS = 400;

const SYSTEM_PROMPT = `You are an autonomous agent in a sandbox. Tools: web search, page fetch, Python, JavaScript, and a shared workspace memory.
Work step by step, one tool call at a time. When you have what you need (or the task is impossible), call \`finish\` with success and your answer. Keep reasoning brief and never finish before gathering what the task needs.
Messages from the person may arrive mid-task; treat each as a further instruction for the same job.`;

/** Replaces all but the newest few tool results with a pointer to the log. */
function compactHistory(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.map((message) => ({ ...message }));
  let kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message.role !== "tool" || !message.content) continue;
    if (kept < KEEP_RECENT_TOOL_RESULTS) {
      kept++;
      continue;
    }
    if (message.content.length > TOOL_STUB_CHARS) {
      message.content = `${message.content.slice(0, 200)}… [earlier tool output shortened; full text is in the task activity log]`;
    }
  }
  return out;
}

/** A date in the system prompt keeps "latest"-style answers honest - without
 * it the model has no idea what day it is and will invent dates. */
function systemPrompt(): string {
  return `${SYSTEM_PROMPT}\n\nToday is ${new Date().toISOString().slice(0, 10)} (UTC).`;
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
  turn?: TurnState
) {
  const dailyBudget = getSettingInt("daily_token_budget", 200000);

  let messages: ChatMessage[];
  let step: number;
  let turnNumber = 1;

  if (turn) {
    messages = compactHistory(turn.messages);
    persistConversation(taskId, messages);
    step = turn.fromStep + 1;
    // Only a restart needs a marker of its own. A follow-up already shows up in
    // the activity log as the person's message, and a second "continuing" line
    // next to it just reads like the run happened twice.
    if (turn.reason === "resume") {
      logStep(taskId, turn.fromStep, "system", `Resumed after a restart (${messages.length} messages carried over).`);
    }
  } else {
    messages = [
      { role: "system", content: systemPrompt() },
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

    // Prior work from this workspace, if anything is relevant.
    const memory = await buildMemoryContext(taskId, goal);
    if (memory) {
      messages[0].content += memory.block;
      updateTask(taskId, { memory_refs_json: JSON.stringify(memory.refs) });
    }

    step = 1;
    logStep(taskId, 0, "system", `Task started. model=${config.model} max_steps=${maxSteps}`);
  }

  updateTask(taskId, { status: "running" });

  while (turnNumber <= MAX_TURNS) {
    turnNumber++;
    const ceiling = step + maxSteps;
    const turnStartStep = step;
    let ended = false;
    let emptyRetries = 0;

    for (; step < ceiling; step++) {
      if (isCancelled(taskId)) {
        logStep(taskId, step, "system", "Task was cancelled.");
        return;
      }

      if (tokensUsedToday() >= dailyBudget) {
        logStep(taskId, step, "error", "Daily token budget reached. Pausing task.");
        updateTask(taskId, { status: "failed", result: "Stopped: daily token budget exhausted." });
        return;
      }

      const incoming = takePendingMessages(taskId);
      if (incoming.length > 0) {
        for (const message of incoming) messages.push({ role: "user", content: message.content });
        persistConversation(taskId, messages);
        // On the first step of a turn the message itself is already in the
        // activity log; only steering that lands mid-run needs its own note.
        if (step > turnStartStep) {
          logStep(
            taskId,
            step,
            "system",
            `${incoming.length} new message${incoming.length > 1 ? "s" : ""} from you — folding ${
              incoming.length > 1 ? "them" : "it"
            } into the plan.`
          );
        }
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
        // A provider sometimes answers with an empty message instead of an
        // error. That is not an answer: retrying is cheap, while recording
        // "[empty response]" would overwrite the task's real result.
        if (!reasoningText.trim()) {
          messages.pop();
          persistConversation(taskId, messages);
          if (emptyRetries < 2) {
            emptyRetries++;
            logStep(taskId, step, "system", "The model returned an empty reply; retrying.");
            continue;
          }
          logStep(taskId, step, "error", "The model returned an empty reply three times. Stopping so the last good result is kept.");
          updateTask(taskId, { status: "interrupted" });
          return;
        }
        logStep(taskId, step, "final", reasoningText);
        updateTask(taskId, { status: "completed", result: reasoningText });
        ended = true;
        break;
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
          ended = true;
          break;
        }

        const toolFn = TOOL_FUNCTIONS[fnName];
        let resultText: string;
        if (!toolFn) {
          resultText = `Unknown tool: ${fnName}`;
        } else {
          try {
            resultText = await toolFn(fnArgs, { taskId });
          } catch (e) {
            resultText = `Tool error: ${e instanceof Error ? e.message : e}`;
          }
        }

        logStep(taskId, step, "tool_result", resultText);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
        persistConversation(taskId, messages);
      }

      if (finished) break;
    }

    // A message may have landed after the last step of this turn; pick it up
    // and keep going rather than declaring the task finished.
    const pending = takePendingMessages(taskId);
    if (pending.length > 0) {
      for (const message of pending) messages.push({ role: "user", content: message.content });
      persistConversation(taskId, messages);
      step++;
      updateTask(taskId, { status: "running" });
      continue;
    }

    if (ended) return;

    logStep(taskId, ceiling, "error", "Max step count reached for this turn without finishing.");
    updateTask(taskId, { status: "failed", result: "Stopped: reached the step cap without finishing." });
    return;
  }

  logStep(taskId, step, "error", "Turn limit reached; stopping to avoid looping.");
  updateTask(taskId, { status: "failed", result: "Stopped: too many consecutive turns." });
}
