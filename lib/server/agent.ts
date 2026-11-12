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
import { countPendingMessages, takePendingMessages } from "./messages";
import { addTokens, logStep, updateTask } from "./events";

export interface TurnState {
  messages: ChatMessage[];
  fromStep: number;
  reason: "resume" | "followup";
}

const MAX_TURNS = 25;

const SYSTEM_PROMPT = `You are an autonomous task-completing agent running in a sandbox.
You have tools to search the web, fetch pages, run Python or JavaScript code, and use a shared workspace memory.
Work step by step. Call one tool at a time. When you have enough information to
answer, or if the task is impossible, call the \`finish\` tool with success=true/false
and your answer. Be concise in your reasoning. Do not call finish until you have
actually gathered the information needed.

The person may send additional messages during the task. Treat each one as a
further instruction for the same job: adjust your plan and continue. If a message
changes the goal materially, follow the message.`;

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
    messages = turn.messages;
    step = turn.fromStep + 1;
    // A follow-up turn normally *has* the new message pending, and that is
    // logged on the first step - logging "continuing" as well duplicates it.
    if (turn.reason === "resume") {
      logStep(taskId, turn.fromStep, "system", `Resumed after a restart (${messages.length} messages carried over).`);
    } else if (countPendingMessages(taskId) === 0) {
      logStep(taskId, turn.fromStep, "system", `Continuing the conversation (${messages.length} messages carried over).`);
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
    const memory = buildMemoryContext(taskId, goal);
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
    let ended = false;

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
        logStep(
          taskId,
          step,
          "system",
          `${incoming.length} new message${incoming.length > 1 ? "s" : ""} from you — folding ${
            incoming.length > 1 ? "them" : "it"
          } into the plan.`
        );
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
      logStep(
        taskId,
        step,
        "system",
        "New message from you — continuing with it in the same conversation."
      );
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
