"use client";

import { useState } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Info,
  Wrench,
} from "lucide-react";
import { Step } from "@/lib/api";

/** Compact activity rows. Tool traffic is the noisiest part of a task, so a
 * call is reduced to its tool name plus a one-line argument preview, and long
 * content stays collapsed until asked for. */
const TRUNCATE_AT = 260;

const KIND_META: Record<
  Step["kind"],
  { icon: React.ComponentType<{ size?: number }>; label: string }
> = {
  thought: { icon: Brain, label: "Thinking" },
  tool_call: { icon: Wrench, label: "Tool call" },
  tool_result: { icon: CornerDownRight, label: "Output" },
  final: { icon: CheckCircle2, label: "Final answer" },
  error: { icon: AlertCircle, label: "Error" },
  system: { icon: Info, label: "System" },
};

function clip(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return '""';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Turns {"tool":"web_search","args":{...}} into a readable label + preview. */
function describeToolCall(content: string): { label: string; preview: string } {
  try {
    const { tool, args } = JSON.parse(content);
    const entries = Object.entries(args ?? {});
    if (entries.length === 0) return { label: String(tool), preview: "no arguments" };

    const [firstKey, firstValue] = entries[0];
    const rest = entries.length - 1;
    return {
      label: String(tool),
      preview: `${firstKey}: ${clip(firstValue)}${rest > 0 ? `  (+${rest} more)` : ""}`,
    };
  } catch {
    return { label: "Tool call", preview: content };
  }
}

export function StepItem({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(false);
  const meta = KIND_META[step.kind] ?? KIND_META.system;
  const Icon = meta.icon;

  const isToolCall = step.kind === "tool_call";
  const described = isToolCall ? describeToolCall(step.content) : null;
  const label = described ? described.label : meta.label;
  const full = described ? described.preview : step.content;

  const isLong = full.length > TRUNCATE_AT;
  const shown = isLong && !expanded ? `${full.slice(0, TRUNCATE_AT)}…` : full;

  return (
    <div className="tl-item" data-kind={step.kind}>
      <span className="tl-icon">
        <Icon size={14} />
      </span>
      <div className="tl-body">
        <div className="tl-head">
          <span className="tl-label">{label}</span>
          <span className="tl-step">#{step.step_index}</span>
        </div>
        <div className="tl-text">{shown}</div>
        {isLong && (
          <button className="tl-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? (
              <>
                Show less <ChevronUp size={11} />
              </>
            ) : (
              <>
                Show all {full.length.toLocaleString()} characters <ChevronDown size={11} />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
