import { NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  const db = getDb();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let lastSeen = 0;
      let closed = false;

      req.signal.addEventListener("abort", () => {
        closed = true;
      });

      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      while (!closed) {
        const rows = db
          .prepare("SELECT id, step_index, kind, content, created_at FROM steps WHERE task_id = ? AND id > ? ORDER BY id ASC")
          .all(taskId, lastSeen) as { id: number; step_index: number; kind: string; content: string; created_at: number }[];

        for (const r of rows) {
          send("step", { step_index: r.step_index, kind: r.kind, content: r.content, created_at: r.created_at });
          lastSeen = r.id;
        }

        const task = db.prepare("SELECT status, result FROM tasks WHERE id = ?").get(taskId) as
          | { status: string; result: string | null }
          | undefined;

        if (task && TERMINAL.has(task.status)) {
          send("done", { status: task.status, result: task.result });
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }

      try {
        controller.close();
      } catch {
        /* already closed by client abort */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
