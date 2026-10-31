import { TaskStatus, statusColor } from "@/lib/api";

export function StatusDot({ status }: { status: TaskStatus }) {
  const color = statusColor[status];
  const pulsing = status === "running";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: pulsing ? `0 0 0 3px ${color}22` : "none",
        }}
      />
      <span style={{ color, fontSize: 12.5 }}>{status}</span>
    </span>
  );
}
