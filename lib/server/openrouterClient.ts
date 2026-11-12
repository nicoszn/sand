/**
 * Thin OpenRouter chat-completions client. Both the model and the API key come
 * from the single `config` module - there is no key pool and no fallback
 * model, so a call either succeeds or reports a clear error.
 */
import { config } from "@/lib/config";

const API_URL = config.openrouterApiUrl;

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
  finish_reason?: string;
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: unknown[],
  maxTokens = 1500
): Promise<ChatCompletionResult> {
  if (!config.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not set - add it to .env.local before running tasks.");
  }

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
  };
  if (tools) payload.tools = tools;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agent-sandbox.local",
      "X-Title": "Agent Sandbox",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    throw new Error(`Rate limited by OpenRouter for model ${config.model}. Try again shortly.`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const usage = data.usage ?? {};
  const choice = (data.choices ?? [{}])[0];

  return {
    message: choice.message ?? {},
    usage,
    finish_reason: choice.finish_reason,
  };
}
