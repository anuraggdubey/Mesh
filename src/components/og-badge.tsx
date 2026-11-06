"use client";

export type Verification = "tee-signature" | "router-checked" | "unverified";

const BADGE: Record<Verification, { label: string; cls: string; hint: string }> = {
  "tee-signature": { label: "Verified by 0G TEE", cls: "bg-emerald-500/15 text-emerald-700", hint: "The provider's signature over the response was checked here against the TEE signer address." },
  "router-checked": { label: "Router-checked only", cls: "bg-amber-500/15 text-amber-700", hint: "The 0G Router says the TEE check passed. We did not verify the provider's signature ourselves." },
  unverified: { label: "Not verified", cls: "bg-red-500/15 text-red-700", hint: "Neither the Router nor a signature check confirmed this answer. Treat it as unverified." },
};

/** The verification level of a 0G answer, worded exactly as on the job page: a TEE claim only when the signature really checked out. */
export function OgBadge({ verification }: { verification: Verification | null }) {
  const b = BADGE[verification ?? "unverified"];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${b.cls}`} title={b.hint}>
      {b.label}
    </span>
  );
}
