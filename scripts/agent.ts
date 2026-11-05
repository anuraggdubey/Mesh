// Scripted agent requester: creates render jobs and pays for them over x402 on Hedera, with no human click.
// Usage: npm run agent -- [preset ...]      (env: see .env.example, AGENT_* and X402_*)
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Agent, AgentRefusal, makeHederaPayer, parsePresetList } from "../src/lib/agent";
import { RENDER_PRICE } from "../src/lib/constants";
import type { RenderPreset } from "../src/lib/constants";

const env = process.env;
const apiUrl = (env.MESH_API_URL ?? env.API_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const mirror = (env.MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const network = (env.X402_NETWORK ?? "hedera:testnet") as `${string}:${string}`;
const asset = env.X402_ASSET?.trim() || "0.0.0";

function fail(msg: string): never {
  console.error(`agent: ${msg}`);
  process.exit(1);
}

async function accountId(evm: string): Promise<string> {
  if (env.AGENT_HEDERA_ACCOUNT_ID) return env.AGENT_HEDERA_ACCOUNT_ID;
  const res = await fetch(`${mirror}/api/v1/accounts/${evm}`);
  if (!res.ok) fail(`the agent wallet ${evm} has no Hedera account yet. Send it some HBAR first, or set AGENT_HEDERA_ACCOUNT_ID.`);
  return ((await res.json()) as { account: string }).account;
}

async function main() {
  const rawKey = env.AGENT_PRIVATE_KEY?.trim();
  if (!rawKey) fail("set AGENT_PRIVATE_KEY (an ECDSA key; the account must hold HBAR)");
  const evm = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex).address;
  const hederaAccount = await accountId(evm);

  const presets = process.argv.slice(2).filter((a) => !a.startsWith("-")) as RenderPreset[];
  const allowed = parsePresetList(env.AGENT_PRESETS);
  const todo = presets.length ? presets : [allowed[0]];

  const agent = new Agent(
    {
      apiUrl,
      requester: evm,
      budget: BigInt(env.AGENT_BUDGET ?? RENDER_PRICE.small),
      perJobCap: BigInt(env.AGENT_JOB_CAP ?? RENDER_PRICE.small),
      allowedPresets: allowed,
      allowedPayTo: env.AGENT_ALLOWED_PAY_TO ? env.AGENT_ALLOWED_PAY_TO.split(",").map((s) => s.trim()) : undefined,
      asset,
      approvalTimeoutMs: 10 * 60_000,
    },
    {
      fetch,
      pay: makeHederaPayer({ accountId: hederaAccount, privateKey: rawKey, network, asset, maxAmount: BigInt(env.AGENT_JOB_CAP ?? RENDER_PRICE.small) * (asset === "0.0.0" ? 100n : 1n) }),
      onApprovalNeeded: (a) => {
        console.log("\nA human must approve this job in World before the agent can spend:");
        console.log(`  code:  ${a.userCode}\n  open:  ${a.verificationUri}\n`);
      },
      log: (l) => console.log(`agent: ${l}`),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  );

  console.log(`agent: ${hederaAccount} (${evm}) -> ${apiUrl}, budget ${agent.config.budget}, per-job cap ${agent.config.perJobCap}`);
  for (const preset of todo) {
    try {
      const r = await agent.runJob(preset);
      console.log(`agent: job ${r.jobId} created (${preset}); spent ${r.spent} of ${agent.config.budget}`);
      if (r.paymentTx) {
        const [acct, rest] = r.paymentTx.split("@");
        console.log(`agent: paid on Hedera, transaction ${r.paymentTx}`);
        console.log(`agent: https://hashscan.io/${network.endsWith("mainnet") ? "mainnet" : "testnet"}/transaction/${rest ? `${acct}-${rest.replace(".", "-")}` : r.paymentTx}`);
      }
      if (r.approvalId) console.log(`agent: approved by a human (${r.approvalId})`);
      await follow(r.jobId);
    } catch (e) {
      if (e instanceof AgentRefusal) {
        console.error(`agent: refused (${e.code}): ${e.message}`);
        process.exitCode = 2;
        continue;
      }
      throw e;
    }
  }
}

/** Poll the job until it reaches a final state. */
async function follow(jobId: string): Promise<void> {
  const final = new Set(["final", "refunded", "expired", "failed"]);
  let last = "";
  for (let i = 0; i < 600; i++) {
    const res = await fetch(`${apiUrl}/api/jobs/${jobId}`);
    if (res.ok) {
      const j = (await res.json()) as { status: string };
      if (j.status !== last) {
        console.log(`agent: job ${jobId.slice(0, 10)}... is ${j.status}`);
        last = j.status;
      }
      if (final.has(j.status)) return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("agent: stopped waiting (the job is still running)");
}

main().catch((e) => {
  console.error("agent:", e instanceof Error ? e.message : e);
  process.exit(1);
});
