# Prize tracks: requirements, our plan, owners

Single reference for the three sponsors we target. Prize text is condensed from the ETHGlobal Mumbai prize pages (pasted by Anurag on 2026-11-06). Technical facts come from the sponsors' docs as read on 2026-11-06 by research agents; items marked **[UNVERIFIED]** were not confirmed by a live call and must be checked before we rely on them. Confirm the live prize text again before submitting.

Related: [job-spec.md](job-spec.md), [QA.md](QA.md), [FEEDBACK-world.md](FEEDBACK-world.md), [FEEDBACK-hedera.md](FEEDBACK-hedera.md), [OG-STATUS.md](OG-STATUS.md).

---

## 0. Rules that shape everything

- **Submit up to 3 partner prizes.** All tracks of one partner count as ONE pick (so World Agent Pass + World IDKit together cost one pick).
- **Continuity-only prizes are not for us** (we started from scratch): World Agent Pass $2,500, World IDKit "Cont", 0G Keep Building, Hedera Built on Hedera, and similar.
- **Demo video:** ETHGlobal wants 2–4 min, at least 720 p, our own voice (no TTS, no phone recording, no speeding up). Hedera accepts up to 5 min. **0G wants under 3 min.** So make ONE video of about **2:45** that satisfies all three.
- **Public GitHub repo** with README (setup, architecture, payment flow, honest limits), steady commit history, `docs/AI.md`.
- **Hedera needs a settled-payment transaction ID in the README** and a HashScan link in the video.
- **World needs a short integration debrief** (time to first success, friction, missing docs, the one improvement with greatest impact). Write it as we go in `docs/FEEDBACK-world.md`.
- 0G: "prizes are paid at 0G's discretion"; they pay only above a quality threshold.

## 1. Our picks and status

| Partner | Tracks we enter | Pool | Fit | Status |
| --- | --- | --- | --- | --- |
| **Hedera** | AI Agents That Pay: x402 on Hedera | $6,500 (3 / 2 / 1.5 k) | Strong | Core. x402 server, agent, spending controls, HCS log and receipts are built and tested against a fake facilitator. **Live settlement needs funded accounts (section 6)**. Escrow funding: option B chosen (2.4) |
| **World** | World ID Agent Pass ($5,000: 2.5 / 1.5 / 1 k) **and** Best Use of IDKit ($2,500, two teams x $1,250) | $7,500 | Strong | Built and tested: IDKit gate, Agent Pass approvals, verify page. **Needs the portal app and client from you (section 6)** |
| **0G** | Build with 0G Private Computer | $5,000 (2.5 / 1.5 / 1 k) | Weak to medium | **Built (Option 2 chosen by you).** 0G is now in the main user flow: a 0G model PLANS each job from the user's words (request id, TEE check, kept on the job and in the HCS log), and a vision model REVIEWS the finished render. Tested with a fake Router; **needs your API key and a live call** ([docs/OG-STATUS.md](OG-STATUS.md)) |

If 0G is dropped, a third pick is optional. Candidates from earlier research: Arkiv "build from scratch" (job board, bids, expiring claims) or Arc smart contracts (conditional escrow). Decide by Friday evening; never let this block the core.

---

## 2. Hedera: "AI Agents That Pay: x402 on Hedera"

### 2.1 Requirements (all must be met)

1. At least one **x402-protected endpoint** that settles on Hedera testnet or mainnet through a facilitator listed in the Hedera docs (Official x402, Ax402 or Blocky402) or one we run.
2. An **agent or client finds the endpoint and completes at least one paid request end to end with no human approving.**
3. **Public repo + README** covering setup, architecture, payment flow and the **Hedera transaction ID of a settled payment**.
4. **Demo video of 5 min or less** showing a payment settling and linking to it on HashScan.

### 2.2 Extra points (we plan most of them)

| Extra | Our plan | Owner |
| --- | --- | --- |
| Spending controls: budgets, per-merchant limits, allowlists, human approval above a threshold | Agent budget, per-job cap, image-digest allowlist, **human approval above a threshold via World Agent Pass** (section 3) | Anurag |
| HCS topic as tamper-evident audit log of agent spending | HCS topic for every state change and payment | Anurag |
| Settling in an HTS token such as USDC | Pay in testnet USDC (`0.0.429274`) if section 2.4 option A | Anurag |
| Agent identity/reputation (HCS-14 or ERC-8004) | Stretch | Anurag |
| Multi-agent negotiation, Scheduled Transactions, Agent Kit, Network MCP | Stretch; only if the core is done | either |

Judging criteria are not listed on the page; ETHGlobal's five apply (Technicality, Originality, Practicality, Usability, WOW).

### 2.3 Technical facts (from the Hedera docs) [UNVERIFIED until a live call]

- **Network string:** CAIP-2 `hedera:testnet` / `hedera:mainnet`.
- **Scheme:** `exact`. **Asset:** `0.0.0` for HBAR; an HTS token ID for tokens, e.g. **testnet USDC `0.0.429274`** (6 decimals). **Amount:** string in the smallest unit (HBAR in tinybars).
- **`payTo` is a Hedera account ID (`0.0.x`)**, not an EVM address. The payee account must be associated with the token or have a free auto-association slot, otherwise the transfer fails with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
- **Requirements object (per accepted option):** `{scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra: {feePayer}}`. The facilitator is the **fee payer**, so the paying agent needs no HBAR for gas.
- **Headers (x402 v2):** server sends `PAYMENT-REQUIRED` (base64 JSON) with the 402; client retries with `PAYMENT-SIGNATURE` (base64 `PaymentPayload`); server answers with `PAYMENT-RESPONSE` (base64 settlement JSON). One Hedera page still says `X-Payment` (v1 name); use the v2 names.
- **PaymentPayload:** `{x402Version: 2, resource, accepted: <the chosen requirements>, payload: {transaction: <base64 partially signed TransferTransaction>}}`. The client builds a `TransferTransaction` (client to `payTo`), sets the fee payer from `extra.feePayer`, signs with its own key, and the facilitator adds its signature and submits.
- **Settlement response:** `{success, transaction (or transactionId), network, payer}`; transaction ID format `0.0.x@seconds.nanoseconds`. HashScan URL pattern is not documented; use `https://hashscan.io/testnet/transaction/<id>` and confirm it resolves.
- **Facilitators (testnet), no API key:**
  - Official x402: `https://x402.org/facilitator` (fee payer `0.0.9185802`)
  - Blocky402: `https://api.testnet.blocky402.com` (fee payer `0.0.7162784`)
  - Launa: `https://testnet.facilitator.launa.dev` (fee payer `0.0.9839454`)
  - Each exposes `GET /supported`, `POST /verify`, `POST /settle`. Request/response JSON for verify/settle is not documented on the pages we read: read `@x402/core` source. **Ax402 was not found in the docs.**
- **Packages:** `@x402/hedera` (server, client, facilitator), `@x402/core` (both 2.30.0 on npm), `@hiero-ledger/sdk` (2.90.1). The package re-exports a subset of the SDK; do not install the SDK twice. Use **ECDSA** keys (`0x...`).
- **Client sketch:** `new x402Client().register("hedera:*", new ExactHederaScheme(createClientHederaSigner("0.0.<id>", PrivateKey.fromString(key), {network: "hedera:testnet"})))`.
- **Server sketch:** `new x402ResourceServer(facilitatorClient)` + `server.register("hedera:*", new ExactHederaScheme({defaultAssets: {"hedera:testnet": {asset: "0.0.429274", decimals: 6}}}))`.
- **Test funds:** HBAR from portal.hedera.com; test USDC from faucet.circle.com (pick "Hedera Testnet"); the payer must be **associated** with the USDC token first (`TokenAssociateTransaction`).
- **Replay protection:** the spec only says facilitators SHOULD reject previously seen transactions and servers "should refuse to serve twice for one transaction". There is no per-request nonce for `cryptoTransfer`, so **we must track served transaction IDs ourselves** (we have a `used_nonces` table).

### 2.4 The design decision: how does an x402 payment reach our escrow?

Conflict: our `MeshEscrow` is an **EVM contract** holding an ERC-20 (`MockStable`); x402 on Hedera pays an **account** (`payTo = 0.0.x`) in HBAR or real HTS tokens.

| Option | How | Pros | Cons |
| --- | --- | --- | --- |
| **A: real USDC in escrow** | `payTo` = the API's Hedera account (treasury). After settlement the API transfers the USDC into the escrow contract (via the token's ERC-20 facade address) and calls `lock`. Redeploy escrow with the HTS USDC facade as `token` and add an `associate()` call so the contract can hold the token | Real money is escrowed; refunds and payouts are real; best story for judges | Redeploy escrow, receipt and stake (about 5.4 HBAR; deployer has 2.8); HTS association work; more to test |
| **B: payment proof only** | `payTo` = treasury. The API treats the settled x402 tx as proof of payment and mints/locks `MockStable` in escrow 1:1 | Fast; no redeploy | Escrow holds worthless mock tokens; slash/refund of "real" payment is not real; judges can call it out |

**Decision (made while building, because time was short): B now, A as the upgrade.** The settled x402 payment goes to the treasury account (the API wallet's Hedera account, or `X402_PAY_TO`); the escrow contract then mirrors it by minting `MockStable` 1:1 (`lockEscrowOnChain` with `devFund` when `job.payment` exists). The README states this plainly: the payment on HashScan is real, the escrow is a mirror of it. Option A (real HTS USDC in escrow) needs a redeploy and about 6 HBAR on the deployer; it is the first thing to do if there is time.

### 2.5 Tasks and owners (Hedera)

| Task | Owner | Notes |
| --- | --- | --- |
| Decide option A or B (2.4) | done | B chosen |
| Install `@x402/hedera`, `@x402/core`; read `@x402/core` for the facilitator verify/settle shapes | done | `@x402/core`, `@x402/hedera`, `@hiero-ledger/sdk` |
| Make `POST /api/jobs` an x402 endpoint (402 with `PAYMENT-REQUIRED`, verify + settle via facilitator, replay check, then mark `paid`) | done | `src/lib/x402.ts`, `src/app/api/jobs/route.ts`; 20 tests with a fake facilitator |
| Treasury account (ECDSA) funded; payer agent account funded with HBAR (or USDC) | **you** | HBAR needs no token association, so no faucet steps for the default asset |
| Scripted agent requester using `x402Client` + spending policy | done | `src/lib/agent.ts`, `scripts/agent.ts` (`npm run agent`); 14 tests |
| Spending controls: budget, per-job cap, allowlist, **human approval above a threshold** | done | budget, per-job cap, preset and payee allowlists, one asset; approval = World Agent Pass |
| HCS audit topic and publisher | code done, **topic needs you** | `src/lib/hcs.ts`; run `npm run hcs:create-topic` once, set `HCS_TOPIC_ID` |
| README: payment flow, settled tx ID, HashScan link | flow done, **tx ID needs a live run** | the ID cannot be written until the agent has paid on testnet |
| Demo scene: agent pays with no human click, HashScan tab open | Anurag drives, Misbah's provider runs the job | |

---

## 3. World: Agent Pass ($5,000) and Best Use of IDKit ($2,500)

### 3.1 Requirements

**World ID Agent Pass** (open to all; the $2,500 variant is Continuity only):
- Integrate the **official World ID Agent Pass**; show the full journey: identity or verification request, user completion, validated result, **protected application or agent action**.
- Show a **denied, expired, cancelled or otherwise unsuccessful path where the protected action does not occur**.
- **Validate in a secure backend**; never expose client secrets or treat an unvalidated client response as authorization.
- Short **integration debrief**. They want "a meaningful action that needs a human identity or approval layer, not just a login screen". The page notes proofs use fake identities ("we are mocking proofs now, so you don't need sandbox app anymore"); do not rely on them for production.

**Best Use of IDKit** (two teams x $1,250):
- IDKit in a functioning app; at least one credential; **verify on the server or on chain**.
- Explain **the specific product event needing trust and why the chosen credential is the minimum sufficient assurance** (we are NOT rewarded for using more credentials).
- Show a successful verification and **one meaningful alternative path** (cancel, unavailable credential, rejection, ineligible user).
- Short integration debrief.

### 3.2 What "Agent Pass" is, from the docs [UNVERIFIED]

"Agent Pass" is not named anywhere in the docs we read. `auth.world.org` ("World IdP") is the linked product: **human continuity for apps and agents**, an OIDC issuer with **human checkpoints (step-up)**, a **device authorization grant for headless agents**, MCP authorization and XAA. We treat it as the Agent Pass. Do not confuse it with **AgentKit** (`@worldcoin/agentkit`, x402 + AgentBook, a different product) or the **human-in-the-loop SDK** (`@worldcoin/human-in-the-loop`, IDKit-based approvals).

- **Issuer** `https://auth.world.org`; discovery `/.well-known/openid-configuration`; authorize `/api/v1/authorize`; token `/api/v1/token`; device `/api/v1/device_authorization`. Sandbox issuer `https://sandbox.auth.world.org`.
- **Headless agent flow (our fit): device grant.** The agent POSTs `device_authorization` (`client_id`, `client_secret`, `scope=openid`) and shows the human the `user_code` / `verification_uri_complete`. The human approves in the World app. The agent polls `token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Device codes expire after 20 minutes, are single use, and **always require fresh authentication**.
- **Poll outcomes:** HTTP 400 `authorization_pending` (keep polling), `slow_down` (add 5 s), `access_denied` (denied, or the required assurance could not be met), `expired_token`, `invalid_grant`. HTTP 503 is never approval.
- **Validate the ID token in the backend:** RS256 against `jwks_uri`; check `iss` exactly, `aud` = our client ID, `exp`, then policy on **`acr`** (`https://world.org/oidc/acr/orb` for Proof of Human), **`amr`** (`["pop"]`) and **`auth_time`** (freshness). Store `(iss, sub)`; `sub` is opaque.
- **Browser step-up** (alternative): authorize with `max_age=0` and `claims={"id_token":{"acr":{"essential":true,"value":"https://world.org/oidc/acr/orb"}}}`, PKCE, `state`, `nonce`; redeem the code once.
- **Portal:** `https://auth.world.org/portal` (sign in with Google). Register a **confidential OIDC client**: client auth method (default `client_secret_basic`; fixed for life), accepted accounts (choose **Orb only**), keep the client ID and secret (shown once, starts `worldidp_client_secret_`).
- **Localhost callbacks are not allowed** (HTTPS only, exact URLs). The device grant avoids this: it needs a registered redirect URI but does not use it. For the browser flow use an HTTPS tunnel.
- **No documented mock mode.** The prize page says proofs are mocked at the hackathon; sandbox docs describe a sandbox issuer and TestFlight sandbox app. Test the real portal client first; if proofs are mocked on World's side we will see it.

### 3.3 IDKit facts [UNVERIFIED until a live call]

- Packages already installed: `@worldcoin/idkit` (React widget `IDKitRequestWidget`), `@worldcoin/idkit-core` (also has `@worldcoin/idkit-core/signing`), `@worldcoin/idkit-server` (v1.2.0).
- **Portal for IDKit is `https://developer.world.org`** (a different portal from auth.world.org). Values: `app_id` (`app_...`), `rp_id` (`rp_...`), `signing_key` (secret).
- **Server creates the RP signature** (`signRequest({signingKeyHex, action})` returns `{sig, nonce, createdAt, expiresAt}`); the client passes it as `rp_context` to the widget.
- **Server verifies:** `POST https://developer.world.org/api/v4/verify/{rp_id}` with the full IDKit result as the body; **pin `environment`** so a client cannot choose `staging`/`sandbox` (those accept test proofs); accept only `success === true`.
- **Nullifier:** per person, per app, per action. The portal checks cryptographic validity only; **we must reject a nullifier we have already seen** (unique `(nullifier, action)`).
- **Credential choice:** **Proof of Human (credential 1)** is the highest-assurance uniqueness signal and the minimum sufficient one for "one human, one provider profile". Selfie Check does not give a strict one-person-one-account guarantee.
- Test: `https://simulator.worldcoin.org/` with `environment: "staging"`.

### 3.4 How we use World (one project, both tracks)

| Trust event in Mesh | World product | Why this credential | Alternative path (required) |
| --- | --- | --- | --- |
| **A provider registers to sell compute** (one human, one provider profile; stake is slashable) | **IDKit, Proof of Human** (action `register-provider`) | Sybil resistance needs strict uniqueness: Proof of Human | Cancelled / unverified / reused nullifier: no provider profile, no on-chain registration |
| **The scripted agent wants to spend above its cap** (human approval layer for an autonomous agent) | **Agent Pass, device grant**, ID token `acr=orb`, fresh `auth_time` | A human must approve a large spend at that moment; fresh Orb-level authentication | Denied / expired / not approved: the job is **not** created and nothing is paid |

Approvals are **bound to the specific action** (price, preset, requester) and **consumed once**; the agent cannot reuse an approval or inflate the amount after approval.

**Fallback chosen (2026-11-06): approval by World ID proof.** The `auth.world.org` portal answered "not eligible" for the team's accounts (it asks for an enterprise account), so no OIDC client exists and the device grant cannot be exercised live. When no client is configured, an approval is answered with an **IDKit Proof of Human made for that one approval** (IDKit action `approve-<approvalId>`), on our page `/approve/<id>`, and verified on the server like the provider proof (spec section 17.1). It keeps the track's journey: request, human completes in the World app, validated result, protected agent action, plus the denied / expired / cancelled path where nothing is created or paid. Stated honestly in the debrief and the docs: this is World ID IDKit, not the official Agent Pass OIDC client. The device-grant code is kept and used automatically if a client becomes available. Unverified until a live scan: that World accepts an action created on the fly in the user's app.

### 3.5 Tasks and owners (World)

| Task | Owner | Notes |
| --- | --- | --- |
| Create the `developer.world.org` app: `app_id`, `rp_id`, `signing_key`; actions `register-provider` | **Anurag (you)** | put in `.env`: `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` |
| Create the `auth.world.org` confidential OIDC client (Orb only); a placeholder HTTPS redirect URI is fine for the device grant | **Anurag (you)** | put in `.env`: `WORLD_IDP_CLIENT_ID`, `WORLD_IDP_CLIENT_SECRET` |
| IDKit server: RP signature route, verify route, nullifier store, wire into provider registration, denied path | Anurag (AI-assisted) | done in code; tested with fixtures |
| IDKit UI: widget on the provider onboarding page | done | `/provider/verify` renders the widget (checked in a browser); the full scan needs real `app_id`/`rp_id` |
| Agent Pass backend: device grant, ID token validation, approval store bound to action, approval policy in `POST /api/jobs` | Anurag (AI-assisted) | done in code; tested with a local fake issuer |
| Agent script: ask for approval above threshold, wait, proceed or stop | done | tested: approved, denied and timeout all leave nothing paid |
| `docs/FEEDBACK-world.md` debrief, with real timings | both | note time to first success, friction, missing docs |
| Demo scene: approval succeeds, then a denied/expired approval creates no job | Anurag | |

---

## 4. 0G: "Build with 0G Private Computer"

### 4.1 Requirements

- **0G is the product:** "a consumer app where AI on 0G is the product: something people open, use, and come back to tomorrow." Creative image, video and voice apps welcome. Every team gets 0G compute credits.
- **Must show:** inference on **0G Private Computer in the main user flow, with request IDs**; a working app a judge can try with a clear reason to come back; **one sentence on what breaks if 0G is removed**.
- **Bonus:** iAI sign-in with the user's own 0G account and a visible credit balance going down (sign-in works only on `localhost:3000/3001/5173`).
- **Not wanted:** generic chat wrappers; apps where the AI call could be removed without anyone noticing.
- **Submission:** name and description, public repo with README, **demo video under 3 min + live demo link**, contract addresses, team names with Telegram and X.

### 4.2 Technical facts [UNVERIFIED until a live call]

- **OpenAI-compatible Router:** mainnet `https://router-api.0g.ai/v1`, testnet `https://router-api-testnet.integratenetwork.work/v1`. Change only `baseURL` and `apiKey` in the OpenAI SDK.
- **API key:** sign in at `pc.0g.ai` (wallet or Google/X/Discord/TikTok via Privy), **deposit 0G tokens to the Router's payment contract**, then Dashboard to API Keys to create an `sk-...` key. Header `Authorization: Bearer sk-...`. The team credits mentioned on the prize page were not described in the docs we read; ask 0G at their booth/Discord.
- **Models:** text (`glm-5.2`, `claude-haiku-5.5`, `gpt-5.5`, `0gm-1.0-35b-a3b`, ...), vision, image generation (`z-image-turbo`, `bytedance/seedream-*`, `tencent/hy-image-*`), speech (`whisper-large-v3`), video (`bytedance/seedance-*`, `minimax-h3`). See `https://pc.0g.ai/models`. Image endpoint `POST /v1/images/generations`; transcription `POST /v1/audio/transcriptions`.
- **Request ID:** in the response **body** at `x_0g_trace.request_id`, together with `x_0g_trace.provider` (on-chain provider address) and billing. The direct (non-Router) flow uses the `ZG-Res-Key` header.
- **Verification:**
  - Router-checked: send `"verify_tee": true`; response has `x_0g_trace.tee_verified` (boolean). This relies on trusting the Router.
  - Independent: look up the provider's `teeSignerAddress` from the on-chain `Service` contract, `GET {url}/v1/proxy/signature/{chatID}?model=...` returns `{text, signature}`; **the signature is EIP-191 `personal_sign` over `text`**; confirm `text` matches the response. SDK: `@0gfoundation/0g-compute-ts-sdk` (0.9.0), `broker.inference.processResponse(providerAddress, chatID)`.
  - **What exactly `text` contains is not documented**; capture a live response before writing the Solidity check.
- **Testnet (Galileo):** chain id `16602`, RPC `https://evmrpc-testnet.0g.ai`, faucet `https://faucet.0g.ai` (0.1 0G per day per wallet).
- **Rate limits:** per account, thresholds unpublished; 429 with `Retry-After`.

### 4.3 Impact on our design

Our plan said a Hedera contract would `ecrecover` a 0G signature over a 32-byte digest. The real signature is **EIP-191 over a variable-length `text`**. So `MeshReceipt.postAttested` must change to take the `text` bytes (hash it with the EIP-191 prefix and length) and compare the recovered address to a configured `ogSigner`. That is a contract change plus a redeploy (see 2.4: plan one redeploy that covers both).

### 4.4 Honest fit assessment

Mesh is a compute marketplace, not a consumer AI app. A bolted-on chat call would be exactly what 0G says it does not want. The only credible fit is an **AI feature people actually use whose output is verifiable on Hedera**, for example: after a render or zoom movie finishes, a 0G vision model describes or checks the frames, shown next to the on-chain receipt, with the request ID and attestation stored in the receipt. Even then "AI is the product" is a stretch. Also, deployed contract addresses and a 0G-specific live demo link are required.

### 4.4b 0G in the main flow (consumer flow)

A person connects a wallet, deposits test HBAR, and types what they need. A 0G model (`planJob` in `src/lib/og.ts`, one chat call with `verify_tee`) turns that into a validated plan; the Mesh agent pays x402 from the user's credit; the plan's **request id** and verification level are stored on the job, shown on the job page and receipt, and published to HCS as a `PLAN` message. If 0G is unavailable the user is told and may pick a size by hand (labelled "not 0G"); we never fake a 0G plan. **What breaks without 0G:** no AI-planned jobs and no traceable plan id. Specs: docs/job-spec.md section 18. **Unproven until a live call:** the real plan call (needs 0G credit) and the model's JSON discipline.

### 4.5 Decision needed

- ~~**Option 1: drop 0G as a pick**~~ (not chosen) and spend the time on Hedera and World quality plus the cheat-caught demo. Optionally add a third pick later (Arkiv).
- **Option 2 (CHOSEN): build it.** Built without a contract redeploy: the 0G attestation is verified off chain and the request id goes on the receipt and HCS. Original scope: one real `infer` job type with request ID and verified signature on chain, plus an AI feature visible in the UI. Needs: a 0G account, deposit, API key, and a live response to inspect the signed `text`.

### 4.6 Tasks and owners (Option 2, built)

| Task | Owner |
| --- | --- |
| Create 0G account, deposit test credits, create the `sk-` key; ask 0G about team credits | **Anurag (you)**: steps in [OG-STATUS.md](OG-STATUS.md) |
| Spike: one live call with `verify_tee`; record `x_0g_trace`, the signed `text`, the signature, the signer; paste to Claude | **you** (or Misbah), commands in OG-STATUS.md |
| Router client, PNG of the finished render, review service, `POST /api/jobs/:id/review`, auto review in the chain loop | done (Claude), 27 tests with a fake Router |
| Off-chain EIP-191 verification of the provider signature, badge levels, request id on the receipt and on HCS (`INFERENCE`) | done (Claude) |
| Job page panel: review text, request id, "Verified by 0G TEE" or "Router-checked only" | done (Claude) |
| `infer` job type in the provider worker, `postAttested` and a contract redeploy | **not needed**: replaced by the off-chain check above (0G signs variable-length text, `postAttested` takes a 32-byte digest). Misbah has no 0G work |
| iAI sign-in bonus | skip |

---

## 5. Cross-cutting deliverables (do not forget)

- [ ] README: setup, architecture, payment flow, **Hedera settled-payment tx ID**, honest limits, third-party code, AI use, partner picks.
- [ ] Demo video about 2:45, our own voice, at least 720 p, shows: agent pays by x402 (HashScan), provider run, cheat caught and slashed, World approval success and denial, receipt.
- [ ] `docs/FEEDBACK-world.md` (required), `docs/FEEDBACK-hedera.md`, `docs/OG-STATUS.md` (written; add the live spike results).
- [ ] Contract addresses in README and `.env.example` (already committed).
- [ ] Team names with Telegram and X handles for the submission form.
- [ ] Live demo link for the web app (needs a public URL for the API with a persistent disk).
- [ ] `docs/AI.md` current; repo history steady.
- [ ] Submission form: pick Hedera, World, and (optionally) 0G or a third partner; choose Finalist + Partner Prizes.
- [ ] Rehearse on two machines; keep a recorded backup.

## 6. Things only Anurag can do (accounts, keys, funds)

1. Create the **`developer.world.org`** app and the **`auth.world.org`** OIDC client; add the values to `.env` (names in 3.5). Set `AGENT_APPROVAL_THRESHOLD` (for example `100000`, so `small` needs a human).
2. Fund the **API wallet** (the treasury) and the **agent wallet** with testnet HBAR; send the agent wallet a little more than the jobs cost (`small` = 0.5 HBAR, `tiny` = 0.1 HBAR). Set `AGENT_PRIVATE_KEY` (an ECDSA key) and `X402_ENABLED=true`.
3. Run `npm run hcs:create-topic` once and put `HCS_TOPIC_ID` in `.env`.
4. Get an HTTPS URL for the API (tunnel or small server) for the World approval and the live demo link.
5. Run the agent live once (`npm run agent -- small`) and paste the settled transaction ID and HashScan link into the README.
6. Push the render image to a shared registry and set `RENDER_IMAGE_REF` / `RENDER_IMAGE_DIGEST` (with Misbah).
7. Record the demo video, fill the Telegram and X handles, submit.
8. **0G**: create the key and run the spike (docs/OG-STATUS.md). 0G also needs its own demo video under 3 minutes and a live demo link.
