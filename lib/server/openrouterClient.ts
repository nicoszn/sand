/**
 * Thin OpenRouter chat-completions client. Pulls a key from the pool for
 * every call, records usage against it, and retries on another key if the
 * provider returns a 429 (that key probably raced past its window).
 */
import { acquireKey, recordUsage, NoAvailableKeyError } from "./keyManager";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export class AllKeysExhaustedError extends Error {}

export interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage: { prompt_tokens?: number; completion_tokens?: number };
  key_id: string;
  key_label: string;
  finish_reason?: string;
}

export async function chatCompletion(
  model: string,
  messages: ChatMessage[],
  tools?: unknown[],
  responseFormat?: unknown,
  maxTokens = 1500,
  attempt = 0
): Promise<ChatCompletionResult> {
  if (attempt >= 3) {
    throw new AllKeysExhaustedError("Exceeded retry attempts across available keys");
  }

  let key: { id: string; key_value: string; label: string };
  try {
    key = acquireKey();
  } catch (e) {
    if (e instanceof NoAvailableKeyError) {
      throw new AllKeysExhaustedError(
        "No OpenRouter key has remaining quota right now." +
          (e.retryAfterSeconds ? ` Next key frees up in ~${Math.ceil(e.retryAfterSeconds)}s.` : "")
      );
    }
    throw e;
  }

  const payload: Record<string, unknown> = { model, messages, max_tokens: maxTokens };
  if (tools) payload.tools = tools;
  if (responseFormat) payload.response_format = responseFormat;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.key_value}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agent-sandbox.local",
      "X-Title": "Agent Sandbox",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    // This key is throttled (shouldn't usually happen since we track
    // locally, but upstream provider-side limits can differ). Record it as
    // used and retry with the next-best key.
    recordUsage(key.id);
    return chatCompletion(model, messages, tools, responseFormat, maxTokens, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const usage = data.usage ?? {};
  recordUsage(key.id, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);

  const choice = (data.choices ?? [{}])[0];
  return {
    message: choice.message ?? {},
    usage,
    key_id: key.id,
    key_label: key.label,
    finish_reason: choice.finish_reason,
  };
}
