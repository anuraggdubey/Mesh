// Runs once when the Next.js server starts. Starts the chain loop (lock escrow, post claims, finalize) when
// MESH_CHAIN_LOOP=true. It is a no-op in the edge runtime and when the loop is off or unconfigured.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startChainLoop } = await import("./lib/settler");
  startChainLoop();
}
