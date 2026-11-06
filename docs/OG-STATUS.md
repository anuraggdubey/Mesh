# 0G Private Computer: status

Track: **Build with 0G Private Computer**. Decision: **built** (Option 2). Nothing here has run against the real 0G Router yet.

## What is built

After a render job reaches `final`, a vision model on 0G looks at the finished image and says what it sees and whether it looks tampered with. This is part of the main flow: the job page shows the review, the 0G **request id**, the model, the provider and a verification badge.

| Piece | Where |
| --- | --- |
| Router client: `POST {OG_API_BASE_URL}/chat/completions` with the image as a data URL, `verify_tee: true`, bearer key, timeout, one retry on 429 honoring `Retry-After` | `src/lib/og.ts` |
| Tiles to a small PNG (colourised, box-averaged to 256 px) | `src/lib/png.ts` |
| Review service: final jobs only, once per job, concurrent callers share one request, result stored on `job.inference` | `src/lib/review.ts` |
| `POST /api/jobs/:id/review` (idempotent) | `src/app/api/jobs/[id]/review/route.ts` |
| Automatic review of new final jobs from the chain loop (needs `OG_ENABLED=true`) | `autoReview` in `src/lib/review.ts`, called from `src/lib/settler.ts` |
| `inference` event, HCS message type `INFERENCE`, receipt field `inference` | `src/lib/hcs.ts`, `src/app/api/receipts/[jobId]/route.ts` |
| Job page panel (loading, error with retry, "not enabled", result with badge) | `src/components/ai-review.tsx` |
| Fake Router and provider signature endpoint for tests | `src/lib/fake-og.ts` |

**What breaks without 0G:** the render, payment and receipt still work, but nobody gets an independent, traceable check of the finished image (a 0G request id and TEE attestation); the AI review panel stays empty.

## Verification levels (never claimed without the check)

| Badge | Meaning |
| --- | --- |
| **Verified by 0G TEE** (`tee-signature`) | We fetched `{text, signature}` from the provider and the EIP-191 signature over `text` recovers to `OG_SIGNER_ADDRESS`, and `text` refers to this response (contains the completion id, the request id or the answer). |
| **Router-checked only** (`router-checked`) | The Router returned `x_0g_trace.tee_verified: true` but we could not verify a signature ourselves (not configured, endpoint failed, or the text did not refer to this response). |
| **Not verified** (`unverified`) | The Router did not confirm, or a signature was fetched and did **not** match the signer (this overrides the Router's claim). |

## Verified by tests (fake Router, 27 tests)

Success; request body has the image, `verify_tee` and the bearer key; `tee_verified` false or missing; wrong signer; unbound text; signature endpoint down; one 429 then success; persistent 429 (`429` + `Retry-After` from our API); 503 outage; non-JSON reply; missing request id; timeout; missing key (503); non-JSON model answer; the API key never appears in logs, errors or stored records; final-only, missing tiles, unknown job; idempotency and concurrent calls; automatic review gated by `OG_ENABLED` and capped at 3 attempts per job; `INFERENCE` on HCS without the description; receipt field.

## NOT verified until a live call (assumptions, all in `src/lib/og.ts`)

1. The Router accepts `image_url` data URLs for the chosen `OG_MODEL` (the default `claude-haiku-5.5` is a guess: check `https://pc.0g.ai/models` for a vision-capable model).
2. The response body has `x_0g_trace.request_id`, `provider`, `tee_verified` (the docs say so; the call fails with a clear error if `request_id` is missing).
3. `verify_tee: true` is accepted for that model.
4. The provider serves `GET {OG_SIGNATURE_BASE_URL}/v1/proxy/signature/{chatID}?model=...` returning `{text, signature}`, `chatID` being the completion `id`. We do not know the provider URL from the Router response. Without `OG_SIGNATURE_BASE_URL` and `OG_SIGNER_ADDRESS` the best we can claim is **Router-checked only**, and the UI says so.
5. What `text` contains is undocumented. If the live text does not contain the completion id, request id or the answer, the binding check fails and the badge stays "Router-checked only"; adjust `checkSignature` after seeing a real response.
6. Image size limits and rate limits (unpublished).

No contract change: the 0G attestation is verified off chain and the request id and signer go on the receipt and on HCS. (`MeshReceipt.postAttested` still exists for a 32-byte digest, but 0G signs variable-length text, so it is not used.)

## What you do (about 20 minutes)

1. Go to **https://pc.0g.ai**, sign in (wallet or Google/X/Discord).
2. Get test credits: the prize page says teams get 0G compute credits, but the docs do not say how. Ask at the 0G booth or Discord. Otherwise get testnet 0G from **https://faucet.0g.ai** (0.1 per day per wallet) and **deposit it to the Router's payment contract** from the dashboard.
3. Dashboard, **API Keys**, create a key (`sk-...`). Put it in `.env` as `OG_API_KEY`. Never paste it in chat or commit it.
4. On https://pc.0g.ai/models pick a model that accepts **images** and set `OG_MODEL`.
5. Optional, for the strongest badge: find the provider's `teeSignerAddress` (the model page or the on-chain Service contract) and the provider URL, set `OG_SIGNER_ADDRESS` and `OG_SIGNATURE_BASE_URL`.
6. Set `OG_ENABLED=true` (automatic review of every final job) and restart.
7. Run a job (`npm run agent -- tiny`, or with `MESH_DEV_SKIP_PAYMENT=true` and the form), wait for `final`, open the job page.

## The spike (record this, then tell Claude)

Run the call once by hand to see the real response shape:

```bash
curl -s "$OG_API_BASE_URL/chat/completions" -H "Authorization: Bearer $OG_API_KEY" -H "content-type: application/json" -d '{"model":"'"$OG_MODEL"'","verify_tee":true,"messages":[{"role":"user","content":"Say hi"}]}'
```

Record: the full `x_0g_trace` object, whether `tee_verified` is true, the `id`, and (if you have the provider URL) the `{text, signature}` from `GET <provider>/v1/proxy/signature/<id>?model=<model>`. Paste them (without the key) to Claude so the binding check and the model default can be fixed to match reality.

## Honest risks for the track

- 0G wants a **consumer app where AI is the product** and a reason to come back tomorrow. Mesh is a compute marketplace; the AI review is a real, traceable use of 0G inside the main flow, but judges may still see it as an add-on. Our one-sentence answer is above (what breaks without 0G).
- The track needs a **demo video under 3 minutes** and a **live demo link** specific to 0G, plus contract addresses (already in the README) and team handles.
- Credits are not guaranteed, and the "iAI sign-in with a visible credit balance" bonus is skipped.
