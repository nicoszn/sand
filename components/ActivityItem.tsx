"use client";

import { useState } from "react";
import {
  AlertCircle,
  Brain,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Globe,
  Info,
  Search,
  Terminal,
  User,
  Wrench,
} from "lucide-react";
import { Step } from "@/lib/api";

/**
 * Activity is grouped rather than listed step-by-step: a tool call and its
 * result are one action, rendered as a single compact row (icon + verb +
 * target + status). The raw arguments and output only appear when the row is
 * opened, so a long task reads as a short outline instead of a text dump.
 */
export type ActivityEntry =
  | {
      id: string;
      kind: "tool";
      stepIndex: number;
      tool: string;
      args: Record<string, unknown>;
      result: string | null;
    }
  | {
      id: string;
      kind: "note";
      stepIndex: number;
      variant: "thought" | "error" | "system" | "user";
      content: string;
    };

type IconType = React.ComponentType<{ size?: number }>;

const TOOL_META: Record<
  string,
  { icon: IconType; verb: string; target: (args: Record<string, unknown>) => string }
> = {
  web_search: { icon: Search, verb: "Web search", target: (a) => String(a.query ?? "") },
  fetch_page: { icon: Globe, verb: "Fetched page", target: (a) => String(a.url ?? "") },
  run_python: { icon: Terminal, verb: "Ran Python", target: (a) => codeSummary(String(a.code ?? "")) },
  run_node: { icon: Braces, verb: "Ran JavaScript", target: (a) => codeSummary(String(a.code ?? "")) },
  recall: { icon: Brain, verb: "Recalled memory", target: (a) => String(a.query ?? "") },
  remember: { icon: Brain, verb: "Saved to memory", target: (a) => String(a.title ?? "") },
  read_task: { icon: Info, verb: "Read prior task", target: (a) => String(a.task_id ?? "") },
  finish: { icon: CheckCircle2, verb: "Finished", target: (a) => String(a.answer ?? "") },
};

const NOTE_META: Record<"thought" | "error" | "system" | "user", { icon: IconType; label: string }> = {
  thought: { icon: Brain, label: "Thinking" },
  error: { icon: AlertCircle, label: "Error" },
  system: { icon: Info, label: "System" },
  user: { icon: User, label: "You" },
};

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

/** A single-line snippet is quoted; anything longer is just counted, which is
 * far more useful at a glance than a cut-off opening bracket. */
function codeSummary(code: string): string {
  const lines = code.split("\n").filter((l) => l.trim().length > 0).length;
  return lines > 1 ? `${lines} lines` : firstLine(code);
}

function isFailure(output: string): boolean {
  return /^(Tool error:|Unknown tool:|\[Execution)/.test(output) || /\[exit code [1-9]/.test(output);
}

export function groupSteps(steps: Step[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // The final answer has its own, better card above the log.
    if (step.kind === "final") continue;

    if (step.kind === "tool_call") {
      const next = steps[i + 1];
      const paired = next && next.kind === "tool_result" && next.step_index === step.step_index;

      let tool = "tool";
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(step.content);
        tool = String(parsed.tool ?? "tool");
        args = (parsed.args ?? {}) as Record<string, unknown>;
      } catch {
        /* malformed arguments - show it as an unknown tool */
      }

      entries.push({
        id: `${step.step_index}-${entries.length}`,
        kind: "tool",
        stepIndex: step.step_index,
        tool,
        args,
        result: paired ? next.content : null,
      });

      if (paired) i++;
      continue;
    }

    if (step.kind === "tool_result") {
      // An output with no call in front of it: show it, but as a plain note.
      entries.push({
        id: `${step.step_index}-${entries.length}`,
        kind: "note",
        stepIndex: step.step_index,
        variant: "system",
        content: step.content,
      });
      continue;
    }

    entries.push({
      id: `${step.step_index}-${entries.length}`,
      kind: "note",
      stepIndex: step.step_index,
      variant: step.kind,
      content: step.content,
    });
  }

  return entries;
}

function prettyArgs(args: Record<string, unknown>): string {
  if (typeof args.code === "string") return args.code;
  if (Object.keys(args).length === 0) return "(no arguments)";
  return JSON.stringify(args, null, 2);
}

function CopyIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="act-copy"
      aria-label="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="act-block">
      <div className="act-block-head">
        <span>{label}</span>
        <CopyIconButton text={text} />
      </div>
      <pre className="act-pre">{text}</pre>
    </div>
  );
}

export function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);

  if (entry.kind === "tool") {
    const meta = TOOL_META[entry.tool] ?? { icon: Wrench, verb: entry.tool, target: () => "" };
    const Icon = meta.icon;
    const tone = entry.result === null ? "pending" : isFailure(entry.result) ? "error" : "ok";
    const target = meta.target(entry.args);

    return (
      <div className="act" data-open={open}>
        <button className="act-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="act-icon" data-tone={tone === "error" ? "error" : "tool"}>
            <Icon size={14} />
          </span>
          <span className="act-main">
            <span className="act-title">{meta.verb}</span>
            {target && <span className="act-target">{target}</span>}
          </span>
          <span className="act-dot" data-tone={tone} title={tone === "pending" ? "running" : tone} />
          <ChevronDown className="act-chevron" size={14} />
        </button>

        {open && (
          <div className="act-detail">
            <DetailBlock label="Arguments" text={prettyArgs(entry.args)} />
            {entry.result !== null ? (
              <DetailBlock label="Output" text={entry.result} />
            ) : (
              <div className="act-pending">Still running…</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const meta = NOTE_META[entry.variant];
  const Icon = meta.icon;
  const preview = entry.content.replace(/\s+/g, " ").trim();
  const hasContent = preview.length > 0;

  // An empty thought (a tool call with no reasoning text) is just noise - show
  // the label, but don't offer a box that opens onto nothing.
  if (!hasContent) {
    return (
      <div className="act" data-variant={entry.variant}>
        <div className="act-row act-row-static">
          <span className="act-icon" data-tone={entry.variant === "error" ? "error" : "note"}>
            <Icon size={14} />
          </span>
          <span className="act-main">
            <span className="act-title">{meta.label}</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="act" data-open={open} data-variant={entry.variant}>
      <button className="act-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span
          className="act-icon"
          data-tone={entry.variant === "error" ? "error" : entry.variant === "user" ? "user" : "note"}
        >
          <Icon size={14} />
        </span>
        <span className="act-main">
          <span className="act-title">{meta.label}</span>
          {!open && <span className="act-target">{preview}</span>}
        </span>
        <ChevronDown className="act-chevron" size={14} />
      </button>

      {open && (
        <div className="act-detail">
          <div className="act-block">
            <div className="act-block-head">
              <span>{meta.label}</span>
              <CopyIconButton text={entry.content} />
            </div>
            <pre className="act-pre">{entry.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
