export async function register() {
  // Only in the real Node server process (not the edge runtime, not during
  // `next build`'s static analysis pass).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTaskRunner } = await import("./lib/server/taskRunner");
    initTaskRunner();
  }
}
