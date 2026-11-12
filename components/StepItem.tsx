"use client";

import { useState } from "react";
import { Brain, Wrench, CornerDownRight, CheckCircle2, AlertCircle, Info, ChevronDown, ChevronUp } from "lucide-react";
import { Step } from "@/lib/api";

const TRUNCATE_AT = 400;

const KIND_META: Record<
  Step["kind"],
  { icon: React.ComponentType<{ size?: number }>; color: string; label: string }
> = {
  thought: { icon: Brain, color: "var(--text-1)", label: "thinking" },
  tool_call: { icon: Wrench, color: "var(--accent-blue)", label: "tool call" },
  tool_result: { icon: CornerDownRight, color: "var(--text-1)", label: "result" },
  final: { icon: CheckCircle2, color: "var(--accent-green)", label: "final" },
  error: { icon: AlertCircle, color: "var(--accent-red)", label: "error" },
  system: { icon: Info, color: "var(--text-2)", label: "system" },
};

/** tool_call content is a JSON string like {"tool":"web_search","args":{...}} -
 * render it as a readable one-liner instead of raw JSON. */
function formatToolCall(content: string): string {
  try {
    const { tool, args } = JSON.parse(content);
    const argStr = Object.entries(args ?? {})
      .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : JSON.stringify(v)}`)
      .join(", ");
    return `${tool}(${argStr})`;
  } catch {
    return content;
  }
}

export function StepItem({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(false);
  const meta = KIND_META[step.kind] ?? KIND_META.system;
  const Icon = meta.icon;

  const displayContent = step.kind === "tool_call" ? formatToolCall(step.content) : step.content;
  const isLong = displayContent.length > TRUNCATE_AT;
  const shown = isLong && !expanded ? displayContent.slice(0, TRUNCATE_AT) + "…" : displayContent;

  return (
    <div style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "6px 0" }}>
      <div style={{ color: "var(--text-2)", flexShrink: 0, width: 24, textAlign: "right", paddingTop: 1 }}>
        {step.step_index}
      </div>
      <div style={{ flexShrink: 0, paddingTop: 1, color: meta.color }}>
        <Icon size={14} />
      </div>
      <div style={{ flexShrink: 0, width: 72, color: meta.color }}>{meta.label}</div>
      <div style={{ color: "var(--text-0)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", flex: 1, minWidth: 0 }}>
        {shown}
        {isLong && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              marginLeft: 6,
              background: "none",
              border: "none",
              color: "var(--accent-amber)",
              fontSize: 11.5,
              cursor: "pointer",
              padding: 0,
              verticalAlign: "middle",
            }}
          >
            {expanded ? (
              <>
                show less <ChevronUp size={12} />
              </>
            ) : (
              <>
                show more <ChevronDown size={12} />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
