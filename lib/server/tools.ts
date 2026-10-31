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

const MAX_OUTPUT_CHARS = 6000;
const CPU_SECONDS = 10;
const PYTHON_MEMORY_KB = 256 * 1024; // ulimit -v is in KB

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

export async function fetchPage(url: string, maxChars = 4000): Promise<string> {
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

export const TOOL_FUNCTIONS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  web_search: (args) => webSearch(String(args.query), typeof args.max_results === "number" ? args.max_results : 5),
  fetch_page: (args) => fetchPage(String(args.url), typeof args.max_chars === "number" ? args.max_chars : 4000),
  run_python: (args) => runPython(String(args.code), typeof args.timeout_seconds === "number" ? args.timeout_seconds : 20),
  run_node: (args) => runNode(String(args.code), typeof args.timeout_seconds === "number" ? args.timeout_seconds : 20),
};
