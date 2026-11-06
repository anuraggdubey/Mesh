import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickWallet } from "./wallet-discovery";
import type { Eip1193 } from "./wallet-discovery";

const fake = (name: string): Eip1193 & { name: string } => ({ name, request: async () => null });

/** A minimal browser: an event target that answers `eip6963:requestProvider` with the wallets we give it. */
function installBrowser(wallets: { uuid: string; name: string; rdns: string; provider: Eip1193 }[], ethereum?: unknown) {
  const target = new EventTarget();
  target.addEventListener("eip6963:requestProvider", () => {
    for (const w of wallets) {
      target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: w.uuid, name: w.name, rdns: w.rdns }, provider: w.provider } }));
    }
  });
  Object.assign(target, { ethereum });
  (globalThis as unknown as { window: unknown }).window = target;
}

describe("wallet discovery", () => {
  beforeEach(() => undefined);
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("picks MetaMask even when another wallet has taken over window.ethereum", async () => {
    const hot = fake("hot");
    const mm = fake("metamask");
    installBrowser(
      [
        { uuid: "1", name: "Hot Wallet", rdns: "app.hot", provider: hot },
        { uuid: "2", name: "MetaMask", rdns: "io.metamask", provider: mm },
      ],
      hot,
    );
    const w = await pickWallet();
    expect(w?.name).toBe("MetaMask");
    expect(w?.provider).toBe(mm);
  });

  it("falls back to the only wallet that announced itself", async () => {
    const hot = fake("hot");
    installBrowser([{ uuid: "1", name: "Hot Wallet", rdns: "app.hot", provider: hot }], hot);
    expect((await pickWallet())?.name).toBe("Hot Wallet");
  });

  it("finds MetaMask in the legacy providers list of window.ethereum", async () => {
    const mm = { ...fake("metamask"), isMetaMask: true };
    const other = fake("other");
    installBrowser([], { ...other, providers: [other, mm] });
    const w = await pickWallet();
    expect(w?.name).toBe("MetaMask");
    expect(w?.provider).toBe(mm);
  });

  it("uses plain window.ethereum when nothing else is available, and reports none when there is no wallet", async () => {
    const lone = fake("lone");
    installBrowser([], lone);
    expect((await pickWallet())?.name).toBe("Browser wallet");
    installBrowser([], undefined);
    expect(await pickWallet()).toBeNull();
  });
});
