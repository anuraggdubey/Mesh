/**
 * Finding the user's wallet. Several browser extensions fight over `window.ethereum` (the last one to load wins, which is
 * how a "Hot wallet" can end up answering for MetaMask). EIP-6963 fixes that: every wallet announces itself separately, so we
 * can ask for all of them and pick MetaMask first.
 */

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?: (event: string, handler: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...a: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export interface PickedWallet {
  provider: Eip1193;
  name: string;
}

interface Announced {
  info: { uuid: string; name: string; rdns?: string };
  provider: Eip1193;
}

/** Ask every EIP-6963 wallet to announce itself and collect the answers. */
export async function discoverWallets(waitMs = 250): Promise<Announced[]> {
  const found = new Map<string, Announced>();
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.info?.uuid && d.provider) found.set(d.info.uuid, d);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  return [...found.values()];
}

/** MetaMask if it is installed (even when another wallet has taken over `window.ethereum`), otherwise the first wallet found. */
export async function pickWallet(): Promise<PickedWallet | null> {
  const list = await discoverWallets();
  const metamask = list.find((w) => w.info.rdns === "io.metamask" || /^metamask/i.test(w.info.name));
  if (metamask) return { provider: metamask.provider, name: "MetaMask" };

  // older wallets that do not announce: several of them may share window.ethereum.providers
  const eth = window.ethereum as (Eip1193 & { providers?: (Eip1193 & { isMetaMask?: boolean })[] }) | undefined;
  const legacy = eth?.providers?.find((p) => p.isMetaMask);
  if (legacy) return { provider: legacy, name: "MetaMask" };

  if (list[0]) return { provider: list[0].provider, name: list[0].info.name };
  if (eth) return { provider: eth, name: "Browser wallet" };
  return null;
}
