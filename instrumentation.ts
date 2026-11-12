export async function register() {
  const { initTaskRunner } = await import("./lib/server/taskRunner");
  initTaskRunner();
}
