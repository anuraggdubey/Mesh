// Run a command with extra environment variables loaded from one or more env files (they override the current
// environment and .env). Cross-platform replacement for `env $(cat file) cmd`.
//
//   npx tsx scripts/with-env.ts .env.localchain -- npx next dev -p 3200
//   npx tsx scripts/with-env.ts .env.localchain .env.localchain.providerA -- npm run worker:provider
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";

const sep = process.argv.indexOf("--");
if (sep < 3 || sep === process.argv.length - 1) {
  console.error("usage: tsx scripts/with-env.ts <envfile> [<envfile>...] -- <command> [args...]");
  process.exit(2);
}
const files = process.argv.slice(2, sep);
const [cmd, ...args] = process.argv.slice(sep + 1);

const extra: Record<string, string> = {};
for (const f of files) Object.assign(extra, parse(readFileSync(f)));

const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...extra } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
