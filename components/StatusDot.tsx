import { TaskStatus } from "@/lib/api";

/** Status is shown as a compact pill rather than a bare dot: same footprint,
 * but it reads at a glance and carries its own colour. */
const TONE: Record<TaskStatus, "neutral" | "running" | "completed" | "failed" | "interrupted"> = {
  queued: "neutral",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "neutral",
  interrupted: "interrupted",
};

export function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span className="pill" data-tone={TONE[status]}>
      <span className="pill-dot" />
      {status}
    </span>
  );
}
