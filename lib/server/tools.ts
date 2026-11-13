/**
 * Tools available to the agent. Kept deliberately lightweight (no headless
 * browser) so they fit inside a 1GB Railway trial service. run_python /
 * run_node execute in a subprocess with a timeout and a CPU/memory cap via
 * `ulimit`, run inside their own process group so a timeout kill takes any
 * children with it.
 *
 * NOTE: this is resource-capped, not network-isolated - see README "Known
 * limitations". Treat it as crash-proof, not as a security boundary.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { rememberFact, searchMemory, searchEpisodes, readTaskDigest, relativeAge } from "./memory";

/** Tool output is resent to the model on every later step, so its size is a
 * per-step cost, not a one-off. 4000 chars is enough for search snippets and
 * page text while keeping a long task affordable. */
const MAX_OUTPUT_CHARS = 4000;
const CPU_SECONDS = 10;
const PYTHON_MEMORY_KB = 256 * 1024; // ulimit -v is in KB

export interface ToolContext {
  taskId: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated, ${text.length - MAX_OUTPUT_CHARS} more chars]`;
}

export async function webSearch(query: string, maxResults = 5): Promise<string> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (AgentSandbox)" } });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const results: string[] = [];
  $(".result").each((_, el) => {
    if (results.length >= maxResults) return;
    const titleEl = $(el).find(".result__a").first();
    if (titleEl.length === 0) return;
    const title = titleEl.text().trim();
    const link = titleEl.attr("href") ?? "";
    const snippet = $(el).find(".result__snippet").first().text().trim();
    results.push(`- ${title}\n  ${link}\n  ${snippet}`);
  });
  return results.length ? truncate(results.join("\n")) : "No results found.";
}

export async function fetchPage(url: string, maxChars = 2500): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (AgentSandbox)" }, redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
    const buf = await res.arrayBuffer();
    return `[Non-text content: ${contentType}, ${buf.byteLength} bytes]`;
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header").remove();
  const text = $("body").text().replace(/\n{3,}/g, "\n\n").trim();
  return truncate(text.slice(0, maxChars));
}

export async function runPython(code: string, timeoutSeconds = 20): Promise<string> {
  return runInSandbox("python3", ["-I"], code, timeoutSeconds, true);
}

export async function runNode(code: string, timeoutSeconds = 20): Promise<string> {
  return runInSandbox("node", ["--max-old-space-size=200"], code, timeoutSeconds, false);
}

async function runInSandbox(
  binary: string,
  extraArgs: string[],
  code: string,
  timeoutSeconds: number,
  capMemory: boolean
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-sandbox-"));
  const ext = binary === "python3" ? "py" : "js";
  const file = path.join(dir, `snippet.${ext}`);
  await writeFile(file, code, "utf8");

  // V8 (node) reserves a large virtual address range up front regardless of
  // actual usage, so `ulimit -v` falsely kills it - cap CPU time only there
  // and rely on --max-old-space-size for the heap. Python is safe to cap
  // with -v directly.
  const ulimits = capMemory ? `ulimit -t ${CPU_SECONDS}; ulimit -v ${PYTHON_MEMORY_KB};` : `ulimit -t ${CPU_SECONDS};`;
  const shellCmd = `${ulimits} exec ${binary} ${extraArgs.join(" ")} "$1"`;

  try {
    return await new Promise<string>((resolve) => {
      const child = spawn("bash", ["-c", shellCmd, "_", file], { detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL"); // negative pid: whole process group
        } catch {
          /* already exited */
        }
      }, timeoutSeconds * 1000);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("close", (codeNum) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve(`[Execution timed out after ${timeoutSeconds}s]`);
          return;
        }
        let combined = stdout;
        if (stderr) combined += `\n[stderr]\n${stderr}`;
        if (codeNum !== 0) combined += `\n[exit code ${codeNum}]`;
        resolve(truncate(combined.trim() || "[no output]"));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`[Execution error: ${err.message}]`);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- memory tools */

async function recall(query: string): Promise<string> {
  const facts = await searchMemory(query, 5);
  const episodes = searchEpisodes(query, 3);
  if (facts.length === 0 && episodes.length === 0) {
    return "Nothing relevant is stored in workspace memory yet. Work it out from scratch (and use `remember` if the answer is worth keeping).";
  }

  const parts: string[] = [];
  if (facts.length > 0) {
    parts.push(
      `Saved facts:\n${facts.map((fact) => `- ${fact.title}: ${fact.content}`).join("\n")}`
    );
  }
  if (episodes.length > 0) {
    parts.push(
      `Earlier tasks that may already cover this:\n${episodes
        .map(
          (episode) =>
            `- ${episode.task_id} (${episode.outcome}, ${relativeAge(episode.updated_at)}): ${episode.goal}\n  ${episode.summary
              .replace(/\s+/g, " ")
              .slice(0, 280)}${episode.summary.length > 280 ? "…" : ""}\n  Call read_task with this id for the full result.`
        )
        .join("\n")}`
    );
  }
  return truncate(parts.join("\n\n"));
}

function remember(
  context: ToolContext,
  args: Record<string, unknown>
): string {
  const saved = rememberFact({
    taskId: context.taskId,
    title: String(args.title ?? ""),
    content: String(args.content ?? ""),
    topic: args.topic ? String(args.topic) : null,
    kind: args.kind ? String(args.kind) : null,
  });
  const where = saved.topicPath ? ` under "${saved.topicPath}"` : "";
  return saved.updated
    ? `Updated the existing memory${where}: ${String(args.title)}`
    : `Saved to workspace memory${where}: ${String(args.title)}`;
}

function readTask(taskId: string): string {
  const digest = readTaskDigest(taskId.trim());
  return digest ?? `No task found with id "${taskId}".`;
}

/* ------------------------------------------------------------- definitions */

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and get a list of result titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Fetch a URL and return its readable text content.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL including https://" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "Execute Python code in a resource-limited sandbox (20s CPU timeout, 256MB memory cap). Use print() to produce output.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "Python source code to execute" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_node",
      description:
        "Execute JavaScript code in a resource-limited Node.js sandbox (20s CPU timeout, 200MB heap cap). Use console.log() to produce output.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript source code to execute" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description:
        "Search workspace memory: durable facts saved by earlier tasks and earlier tasks themselves. Use this before repeating research.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What you are looking for" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save one durable fact that later tasks should know. Not for secrets, one-off details, or values that change within days unless you record the date.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 160, description: "Short label, e.g. 'Bitcoin price 2025-11-12'" },
          content: { type: "string", maxLength: 2000, description: "The fact, with dates and caveats" },
          topic: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9 -]*(/[a-z0-9][a-z0-9 -]*)*$",
            description: "Hierarchical path in lower case, e.g. 'crypto/prices'",
          },
          kind: { type: "string", enum: ["fact", "note", "entity", "preference"] },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_task",
      description:
        "Read the goal, tools and full result of an earlier task by id (ids appear in your workspace memory notes and in recall results).",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "Task id, e.g. 05b5f2564f79" } },
        required: ["task_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "Call this when the task is complete (or cannot be completed) to submit the final answer and stop.",
      parameters: {
        type: "object",
        properties: {
          success: { type: "boolean", description: "Whether the task was completed successfully" },
          answer: { type: "string", description: "The final answer or result, or an explanation of why it failed" },
        },
        required: ["success", "answer"],
      },
    },
  },
];

export const TOOL_FUNCTIONS: Record<
  string,
  (args: Record<string, unknown>, context: ToolContext) => Promise<string>
> = {
  web_search: async (args) =>
    webSearch(String(args.query), typeof args.max_results === "number" ? args.max_results : 5),
  fetch_page: async (args) =>
    fetchPage(String(args.url), typeof args.max_chars === "number" ? args.max_chars : 2500),
  run_python: async (args) =>
    runPython(String(args.code), typeof args.timeout_seconds === "number" ? args.timeout_seconds : 20),
  run_node: async (args) =>
    runNode(String(args.code), typeof args.timeout_seconds === "number" ? args.timeout_seconds : 20),
  recall: async (args) => recall(String(args.query ?? "")),
  remember: async (args, context) => remember(context, args),
  read_task: async (args) => readTask(String(args.task_id ?? "")),
};
