"use client";

import { useIDKitRequest, type IDKitRequestHookConfig, type IDKitResult } from "@worldcoin/idkit";
import { useEffect, useState } from "react";
import { WorldConnectQr } from "./world-connect-qr";

type Props = IDKitRequestHookConfig & {
  onClose: () => void;
  onSuccess: (result: IDKitResult) => void;
  onError: (code: string) => void;
};

export function WorldConnectDialog({ onClose, onSuccess, onError, ...config }: Props) {
  const flow = useIDKitRequest(config);
  const [copied, setCopied] = useState(false);

  // A newly mounted dialog owns one request. Upstream's widget also opens only
  // on mount; reset() is the explicit user action that starts another request.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- do not recreate requests on poll updates
  useEffect(() => flow.open(), []);
  useEffect(() => {
    if (flow.result) onSuccess(flow.result);
  }, [flow.result, onSuccess]);
  useEffect(() => {
    if (flow.errorCode) onError(String(flow.errorCode));
  }, [flow.errorCode, onError]);

  if (flow.result) return null;
  const uri = flow.connectorURI;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="world-connector-title" className="relative max-h-dvh w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 text-center shadow-2xl">
        <button type="button" onClick={() => { flow.reset(); onClose(); }} aria-label="Close" className="absolute right-4 top-3 rounded px-2 text-2xl text-muted hover:bg-muted">×</button>
        <h2 id="world-connector-title" className="mt-6 font-display text-2xl font-medium text-ink">Connect your World ID</h2>
        <p className="mt-2 text-sm text-muted">{flow.isAwaitingUserConfirmation ? "Finish verifying on your other device." : "Scan the QR, or open the connect link on another device."}</p>
        {flow.isError ? (
          <p role="alert" className="my-10 text-sm text-danger">World ID connection failed ({String(flow.errorCode)}). No proof was provided. Start a fresh connection.</p>
        ) : uri ? (
          <>
            <WorldConnectQr connectorUri={uri} />
            <a href={uri} className="btn-primary mt-5" target="_blank" rel="noreferrer">Open World connect link on another device</a>
            <button type="button" className="btn-secondary mt-3" onClick={async () => {
              try {
                await navigator.clipboard.writeText(uri);
                setCopied(true);
              } catch {
                // The real URI remains selectable when clipboard access is denied.
              }
            }}>{copied ? "Copied" : "Copy connect link"}</button>
            <p className="mt-3 break-all rounded-xl bg-muted p-3 text-left text-xs text-muted"><span className="font-medium text-ink">Connect link: </span>{uri}</p>
            {config.environment === "staging" ? (
              <p className="mt-4 text-xs text-muted">Testing in staging? <a href={`https://simulator.worldcoin.org/?connect_url=${encodeURIComponent(uri)}`} target="_blank" rel="noreferrer" className="text-accent underline">Use the World ID simulator</a>. For actual World App verification, use production.</p>
            ) : null}
          </>
        ) : <p role="status" className="my-10 animate-pulse text-sm text-muted">Preparing a fresh signed World connection…</p>}
        <button type="button" onClick={() => { setCopied(false); flow.reset(); }} className="mt-5 text-sm text-muted underline underline-offset-4">Start a fresh connection</button>
      </section>
    </div>
  );
}
