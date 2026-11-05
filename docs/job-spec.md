# Mesh Job Spec v1

The contract between **Misbah's side** (provider worker, verifier, job images) and **Anurag's side** (API, contracts, UI, scripted agent). If code and this file disagree, fix this file first, tell the other person, then change the code.

Items marked **[TBD-VERIFY]** depend on sponsor docs we have not confirmed yet; they are collected in §14.

---

## 1. Conventions

| Thing | Rule |
| --- | --- |
| Hash | SHA-256, output as lowercase hex without `0x` in JSON **unless the field is named `*Bytes32` or is an on-chain `bytes32`**, where it is `0x` + 64 hex |
| `jobId` | 32 random bytes, `0x` + 64 hex (also the on-chain `bytes32 jobId`) |
| Address | EVM address, EIP-55 checksummed in JSON, 20 bytes in hashing |
| Integers in JSON | numbers if < 2^53, else decimal strings. Money is always a decimal string in the smallest unit |
| Byte order | Big-endian for anything hashed (indexes, counters) **except** pixel data (little-endian, §4.3) |
| Time | Unix seconds (integer) |
| Platform | All job images are `linux/amd64`. Always run with `--platform linux/amd64` |
| Determinism | No floating point in anything hashed. Integer / fixed-point only |
| Encoding | UTF-8, JSON, no trailing commas |
| API base | `${API_PUBLIC_URL}/api` |

Shared constants live in `src/lib/constants.ts` and must match this file.

---

## 2. Job object

```jsonc
{
  "jobId": "0x…32 bytes",
  "type": "render",                      // render | matmul | infer | echo
  "mode": "deterministic",               // deterministic | attested
  "status": "created",                   // see §2.1
  "requester": "0x…address",
  "worldNullifier": "0x…",               // null until World check passes
  "imageRef": "ghcr.io/mesh/render@sha256:…",
  "imageDigest": "sha256:…",             // the exact image digest the agent must run
  "inputHash": "…64 hex",                // SHA-256 of the canonical input.json bytes
  "params": { },                         // type-specific, see §4–§6
  "tileCount": 64,
  "providers": ["0x…"],                  // assigned providers (round-robin order, see §3.3)
  "tiles": [
    { "index": 0, "owner": "0x…", "status": "pending", "tileHash": null }
  ],
  "merkleRoot": null,                    // 0x… once all tiles are in
  "price": "1000000",                    // smallest unit
  "asset": "…",                          // [TBD-VERIFY] see §9
  "stakeRequired": "…",
  "timeoutSeconds": 120,
  "createdAt": 0,
  "claimTx": null,
  "finalTx": null,
  "fraudTx": null,
  "slashTx": null,
  "refundTx": null,
  "releaseTx": null,
  "receiptTx": null,
  "hcsSequence": [],                     // HCS sequence numbers for this job's events
  "sample": null,                        // see §7.3
  "verdict": null,                       // "ok" | "fraud" | null
  "inference": null                      // infer jobs only: {requestId, signer, digest}, see §6
}
```

### 2.1 Status values and transitions

```
created ──(x402 payment verified, escrow locked)──▶ paid
paid ──(tiles assigned)──▶ assigned
assigned ──(first provider starts)──▶ running
running ──(all tiles + claim received; postClaim mined)──▶ pending      (challenge window open)
pending ──(verifier ok + window elapsed; finalize mined)──▶ final        ──▶ released (escrow paid out)
pending ──(fraud proven)──▶ rejected ──▶ slashed + refunded
any non-terminal ──(timeout)──▶ expired ──▶ refunded
running ──(provider failure, no reassignment possible)──▶ failed ──▶ refunded
```

Terminal: `final` (+`releaseTx`), `rejected` (+`slashTx`, `refundTx`), `expired`, `failed` (+`refundTx`).
The `challenged` status is reserved for a future public-challenge flow and unused in v1.

---

## 3. Tiling and assignment

### 3.1 Tile count

`tileCount` must be a **power of two** (v1 default **64**, an 8×8 grid). This makes the Merkle tree perfect (no odd-node rules).

### 3.2 Tile index

Row-major: `index = row * gridCols + col`, `row` and `col` start at 0 at the top-left.

### 3.3 Owner assignment (deterministic, contract-computable)

`providers[]` is the ordered list stored on chain in `postClaim`. Tile `i` is owned by `providers[i % providers.length]`. The API fixes `providers[]` at assignment time and never reorders it.

> v1 simplification: if a provider drops mid-job, the API cancels the attempt and re-runs the whole job on a fresh `providers[]` (new assignment, same `jobId`, nothing posted on chain yet). There are no per-tile ownership overrides in v1.

---

## 4. `render` job (primary demo job)

### 4.1 Input file (`/input/job.json`)

```json
{
  "spec": "render-v1",
  "width": 512,
  "height": 512,
  "gridCols": 8,
  "gridRows": 8,
  "x0": "-8589934592",
  "y0": "-6442450944",
  "step": "25165824",
  "maxIter": 20000,
  "tiles": [0, 1, 2, 3]
}
```

- `x0`, `y0`, `step` are **Q31.32 signed fixed-point integers as decimal strings** (value × 2^32).
- `tiles` = tile indices **this container run must compute** (the provider's assignment, or the verifier's sample).
- The canonical `inputHash` of a *job* is `sha256` of the job-level `input.json` **with `tiles` omitted**: serialize with keys in the order shown above, no whitespace, then SHA-256. The per-run file given to the container adds `tiles`.
- Dimension rules: `width`, `height` powers of two; `tileW = width / gridCols`, `tileH = height / gridRows`; `step = 3·2^32 / width` (exact because `width` is a power of two).

### 4.2 Presets

| Preset | width×height | grid | maxIter | `step` | Use |
| --- | --- | --- | --- | --- | --- |
| `tiny` | 64×64 | 2×2 (4 tiles) | 500 | `201326592` | cross-OS determinism test on weak machines |
| `small` | 2048×2048 | 8×8 (64) | 6000 | `6291456` | rehearsals, cheat run (~5 s) |
| `full` | 2048×2048 | 8×8 (64) | 48000 | `6291456` | the heavy demo (~30 s) |

`x0 = -8589934592` (−2.0), `y0 = -6442450944` (−1.5) for all presets. The `small` and `full` presets were measured on Misbah's provider machine using the final `linux/amd64` image, 15 CPUs, and a 1 GiB memory limit: 4.06 s and 28.87 s respectively for all 64 tiles. Runtime varies with available CPU; rehearse on the actual provider machine.

> `tiny` has 4 tiles, a power of two, so it is valid.

### 4.3 Algorithm (must be bit-exact; reference pseudocode)

Fixed-point type: signed 64-bit integer, 32 fractional bits. Intermediates need 128 bits (use BigInt / `i128` / `math/bits`).

```
FRAC = 32
FOUR = 4 << 32

mul(a, b) = (a * b) >> 32          // arithmetic (floor) shift of the 128-bit product

for each tile index t in input.tiles:
  row = t / gridCols ; col = t % gridCols       // integer division
  for j in 0 .. tileH-1:            // pixel row inside the tile (top to bottom)
    for i in 0 .. tileW-1:          // pixel col inside the tile (left to right)
      px = col*tileW + i ; py = row*tileH + j
      cx = x0 + px * step           // exact integer arithmetic
      cy = y0 + py * step
      zr = 0 ; zi = 0 ; n = 0
      while n < maxIter:
        zr2 = mul(zr, zr)
        zi2 = mul(zi, zi)
        if zr2 + zi2 > FOUR: break
        t2  = zr * zi                          // full 128-bit product, NOT pre-shifted
        zi  = (t2 >> 31) + cy                  // == 2*zr*zi >> 32, then + cy
        zr  = zr2 - zi2 + cx
        n  += 1
      pixel(i, j) = n                          // iteration count, 0..maxIter
```

Rules that matter for bit-exactness:
1. `mul` uses an arithmetic (sign-extending, floor) right shift. In JS BigInt `>>` is arithmetic; in Rust use `i128 >> 32`; in Go use `math/bits` or `big.Int.Rsh` on non-negative handling carefully, or compute with `int128` emulation and floor semantics.
2. The `zi` update uses `(zr*zi) >> 31` with the **full-precision product**, then adds `cy`. Do not compute `2*mul(zr,zi)`.
3. Update `zi` before `zr` is overwritten (the pseudocode computes `zr2`, `zi2`, `t2` first from the old `zr`, `zi`).
4. The escape test happens **before** the update and compares `zr2 + zi2 > FOUR`; `n` is the number of completed updates.
5. `maxIter ≤ 65535`.

### 4.4 Output format

For each tile `t` write `/output/tile-<t>.bin` where `<t>` is the decimal tile index with **no zero padding** (`tile-0.bin`, `tile-17.bin`).

- Size: `tileW * tileH * 2` bytes (for 512/8 = 64 → 8192 bytes).
- Pixels in row-major order within the tile (`j` outer, `i` inner).
- Each pixel: `n` as **unsigned 16-bit little-endian**.
- Exit code `0` on success. Anything else = failure.

`tileHash = sha256(contents of tile-<t>.bin)`.

### 4.5 Container contract

```
docker run --rm --platform linux/amd64 --network none \
  --cpus <n> --memory <m> --pids-limit 256 --read-only \
  --tmpfs /tmp:rw,size=64m \
  -v <workdir>/input:/input:ro -v <workdir>/output:/output:rw \
  <imageRef>@<digest>
```

No arguments, no environment variables are required. The image reads `/input/job.json` and writes `/output`. It must not need the network.

---

## 5. `matmul` job (stretch)

- Modulus `p = 2147483647` (2^31 − 1). Matrices are `n × n`, entries in `[0, p)`, stored row-major as **uint32 little-endian**.
- `A`, `B` are generated from a seed: entry `k` (counting row-major, `A` then `B`) = `uint32_be(sha256(seed || uint32_be(k))[0:4]) mod p`. `seed` is a 32-byte value in `job.json`.
- Input `job.json`: `{"spec":"matmul-v1","n":1024,"seed":"0x…"}`. Output `/output/c.bin` = `C = A·B mod p`, row-major uint32 LE.
- Tile unit: row blocks (e.g. 16 row-bands for `tileCount = 16`); tile `t` is the band of rows `[t*n/tileCount, (t+1)*n/tileCount)`; file `tile-<t>.bin`.
- **Verification:** Freivalds, ≥ 20 rounds, `r` vectors from `sha256(sampleSeed || round)` (entries mod p). Accept iff `A(Br) ≡ Cr (mod p)` for all rounds. False-accept probability ≤ 2⁻²⁰ (over mod-p it is ≤ 1/p per round, but state 2⁻²⁰ conservatively).
- Same Merkle/claim/fraud format as `render` (`tile-<t>.bin`), with the fraud payload naming the failing band.

---

## 6. `infer` job (0G, mode `attested`)

- Input `job.json`: `{"spec":"infer-v1","model":"<0G model id>","prompt":"…","maxTokens":256,"temperature":0}`.
- The provider worker calls 0G Private Computer (OpenAI-compatible) and writes `/output/result.json`:

```json
{
  "text": "model output",
  "requestId": "0g request id",
  "model": "…",
  "signer": "0x…0G signer address",
  "signature": "0x…",
  "digest": "0x…32 bytes",
  "signedMessage": "describe exactly what was signed"
}
```

- `digest` = the 32-byte hash that the TEE signed. **[TBD-VERIFY]** exact construction (e.g. EIP-191 over a hash of the response).
- This job is **not** re-executed. Verification is signature-based (§8.1 `postAttested`).
- Network: this is the one job type allowed outbound network, restricted to the 0G host. Misbah's worker enforces the allowlist.
- Tile count is 1. `tiles[0]` is `result.json`; `tileHash = sha256(result.json)`; no Merkle proof needed (`merkleRoot = leaf`).
- What the signature proves and does not prove: see the plan §8.5. State it in the UI.

---

## 7. Hashing, Merkle tree, claims, sampling

### 7.1 Leaf and node hashing (SHA-256, domain separated)

```
tileHash   = sha256(raw tile bytes)                                  // 32 bytes
leaf(i)    = sha256( 0x00 || uint16_be(i) || tileHash || owner )     // owner = 20 raw address bytes
node(l, r) = sha256( 0x01 || l || r )
```

- Leaves ordered by tile index `0 … tileCount-1`. Tree is binary and perfect.
- `merkleRoot` = root hash, `0x` + 64 hex.
- **Proof** for tile `i`: list of `log2(tileCount)` sibling hashes from leaf level upward. At level `L`, if bit `L` of `i` is 0 the sibling is on the right (`node(cur, sib)`), else on the left (`node(sib, cur)`).
- Solidity verifies with the `sha256()` precompile.

Because the owner address is inside the leaf, a fraud proof reveals who owned the bad tile, and the contract can slash it.

### 7.2 Provider claim (EIP-712)

Every provider signs one claim per job for **its own tiles**:

```
EIP-712 domain: { name: "Mesh", version: "1", chainId: HEDERA_CHAIN_ID, verifyingContract: RECEIPT_ADDRESS }

TileClaim {
  bytes32 jobId
  bytes32 imageDigest      // sha256 digest bytes of the image, 32 bytes
  bytes32 inputHash
  address provider
  bytes32 tilesDigest
}

tilesDigest = sha256( concat over this provider's tiles in ascending index of ( uint16_be(i) || tileHash ) )
```

- The API verifies the signature off chain and stores it.
- **v1 trust note:** the contract does **not** verify provider signatures. The API aggregates the tiles, builds the Merkle root, and calls `postClaim`. The signed `TileClaim`s are published to HCS, so anyone can verify attribution off chain. The API is trusted for attribution in v1 (listed as a known limit in the README). The on-chain slash is bound to the owner address inside the leaf.

### 7.3 Sampling (deterministic and reproducible by anyone)

After `postClaim` is mined in block `B`:

```
beacon     = blockHash(B)                       // 32 bytes, from JSON-RPC receipt.blockHash
sampleSeed = sha256( "mesh-sample-v1" || jobId || merkleRoot || beacon )   // ASCII tag, then raw bytes
k          = max(1, ceil(tileCount * sampleRate))     // sampleRate default 0.25 → k = 16 of 64
```

Selection (Fisher–Yates with a SHA-256 counter stream):

```
idx = [0, 1, …, tileCount-1]
ctr = 0
for i from tileCount-1 down to 1:
  r = uint32_be( sha256( sampleSeed || uint32_be(ctr) )[0:4] ) ; ctr += 1
  j = r mod (i + 1)
  swap(idx[i], idx[j])
sample = sorted( idx[tileCount-k .. tileCount-1] )
```

Store in the job: `{"beacon":"0x…","seed":"0x…","k":16,"indices":[…]}`.

The provider cannot know `beacon` before it submits the claim.

Detection probability for a cheater that corrupts `c` of `n` tiles with sample size `k`: `1 − C(n−c, k) / C(n, k)`. For `n=64, k=16`: `c=6 → ~0.84`, `c=12 → ~0.98`, `c=20 → ~0.999`. Demo cheat corrupts ≥ 20 tiles.

### 7.4 Fraud payload

```json
{
  "jobId": "0x…",
  "tileIndex": 17,
  "owner": "0x…",
  "expectedTileHash": "0x…",
  "claimedTileHash": "0x…",
  "proof": ["0x…", "0x…", "0x…", "0x…", "0x…", "0x…"]
}
```

On chain: the contract recomputes `leaf(tileIndex, claimedTileHash, owner)`, verifies it against the stored `merkleRoot` with `proof`, checks `expectedTileHash != claimedTileHash`, requires `msg.sender == verifier`, then slashes `owner`, refunds the requester, and marks the receipt `rejected`.

The verifier's recomputed `expectedTileHash` is evidence stored off chain and in HCS; the contract trusts the verifier key for that single comparison (v1 limit).

---

## 8. Contract interfaces (Solidity, Hedera EVM)

Signatures are authoritative for the ABI. Owner of this section: Anurag.

### 8.1 `MeshReceipt`

```solidity
enum Status { None, Pending, Final, Rejected, Attested }

struct Receipt {
  Status  status;
  address requester;
  bytes32 imageDigest;
  bytes32 inputHash;
  bytes32 merkleRoot;      // or the leaf for infer
  uint64  postedAt;
  uint64  windowEnd;
  bytes32 attestationDigest; // infer only
  string  zeroGRequestId;    // infer only
}

function postClaim(
  bytes32 jobId, address requester, bytes32 imageDigest, bytes32 inputHash,
  bytes32 merkleRoot, address[] calldata providers, uint16 tileCount
) external;                       // onlyApi

function finalize(bytes32 jobId) external;                       // after windowEnd, status Pending → Final; calls escrow.release
function postFraud(
  bytes32 jobId, uint16 tileIndex, address owner,
  bytes32 expectedTileHash, bytes32 claimedTileHash, bytes32[] calldata proof
) external;                       // onlyVerifier → Rejected; stake.slash + escrow.refund
function postAttested(
  bytes32 jobId, address requester, address provider, bytes32 outputDigest,
  string calldata zeroGRequestId, bytes calldata teeSignature
) external;                       // onlyApi; ecrecover(teeSignature over outputDigest) == OG_SIGNER → Attested; escrow.release
function getReceipt(bytes32 jobId) external view returns (Receipt memory);
function providersOf(bytes32 jobId) external view returns (address[] memory);
function tileCountOf(bytes32 jobId) external view returns (uint16);
// pure helpers so off-chain code can check the exact tree encoding (use for golden vectors)
function computeLeaf(uint16 index, bytes32 tileHash, address tileOwner) external pure returns (bytes32);
function verifyTile(bytes32 merkleRoot, uint16 index, bytes32 tileHash, address tileOwner, bytes32[] calldata proof)
  external pure returns (bool);
// owner-only
function setConfig(address ogSigner, uint64 windowSeconds, uint256 minStake, uint256 slashAmount) external;
function withdrawRetained(address payable to, uint256 amount) external;

event ClaimPosted(bytes32 indexed jobId, address indexed requester, bytes32 merkleRoot, uint64 windowEnd);
event ReceiptFinal(bytes32 indexed jobId);
event FraudProven(bytes32 indexed jobId, uint16 tileIndex, address indexed owner);
event AttestedPosted(bytes32 indexed jobId, bytes32 outputDigest, string zeroGRequestId);
event SlashDistributed(bytes32 indexed jobId, uint256 toRequester, uint256 toVerifier, uint256 retained);
```

Constructor: `(api, verifier, stake, escrow, ogSigner, windowSeconds, minStake, slashAmount)`.

Rules (all covered by Foundry tests):
- Append-only: a `jobId` can be posted once; replays revert (`AlreadyPosted`).
- `postClaim` requires the escrow to be `Locked` for that `jobId`, `tileCount` a power of two (≤ 4096), 1–16 distinct non-zero providers, and every provider registered with `stake ≥ minStake`. It also locks each provider's stake until `windowEnd` so they cannot unstake while a claim is pending.
- `finalize` is callable by anyone, reverts while `block.timestamp <= windowEnd`, and only from `Pending`.
- `postFraud` only by the verifier, only while `Pending` and `block.timestamp <= windowEnd`, requires `expectedTileHash != claimedTileHash`, requires `tileOwner == providers[tileIndex % providers.length]`, and a proof of exactly `log2(tileCount)` siblings that reproduces `merkleRoot` for `leaf(tileIndex, claimedTileHash, tileOwner)`.
- `postAttested` recovers an **EIP-191 personal-sign** signature over the 32-byte `outputDigest` and requires it to equal `ogSigner`. **[TBD-VERIFY]** whether 0G signs exactly this; the message construction is isolated in `_recoverEip191`.
- Provider signatures are **not** verified on chain (see §7.2 v1 trust note).

### 8.2 `MeshStake`

```solidity
constructor(address api, uint256 unlockDelay);
function setReceipt(address receipt) external;                    // owner, once
function registerProvider(address provider, bytes32 worldNullifier) external;   // onlyApi; one profile per human, one nullifier per wallet
function isRegistered(address provider) external view returns (bool);
function isEligible(address provider, uint256 minStake) external view returns (bool);  // registered && stake >= minStake
function stake() external payable;                                // must be registered
function requestUnstake() external;                               // starts the unlock delay
function unstake(uint256 amount) external;                        // after unlockDelay AND after lockedUntil
function stakeOf(address provider) external view returns (uint256);
function extendLock(address provider, uint64 until) external;     // onlyReceipt: pending claim blocks unstaking
function slash(address provider, bytes32 jobId, uint256 amount, bytes32 reason)
  external returns (uint256 slashed);                              // onlyReceipt; capped at the provider's stake; one slash per jobId

event Registered(address indexed provider, bytes32 indexed nullifier);
event Staked(address indexed provider, uint256 amount);
event UnstakeRequested(address indexed provider, uint64 availableAt);
event Unstaked(address indexed provider, uint256 amount);
event Slashed(address indexed provider, bytes32 indexed jobId, uint256 amount, bytes32 reason);
```

Stake is the native currency (HBAR). `slash` transfers the slashed funds to the **receipt contract**, which splits them in `postFraud`: **50% requester, 25% verifier, 25% retained** by the receipt contract (owner can withdraw the retained share). Payouts to the requester and verifier are best-effort so a reverting recipient cannot block the slash or refund.

### 8.3 `MeshEscrow`

```solidity
constructor(IERC20 token, address api, uint256 refundAfter);
function setReceipt(address receipt) external;                                   // owner, once
function lock(bytes32 jobId, address requester, uint256 amount) external;      // onlyApi, AFTER the x402 payment arrived at this contract; reverts PaymentNotReceived if token balance < held + amount
function release(bytes32 jobId, address[] calldata providers) external;          // onlyReceipt; equal split, remainder to providers[0]
function refund(bytes32 jobId) external;                                         // receipt or api any time; anyone after refundAfter seconds
function statusOf(bytes32 jobId) external view returns (EscrowStatus);           // None, Locked, Released, Refunded
event Locked(bytes32 indexed jobId, address indexed requester, uint256 amount);
event Released(bytes32 indexed jobId, uint256 amount);
event Refunded(bytes32 indexed jobId, uint256 amount);
```

`release` and `refund` are mutually exclusive per `jobId`; reentrancy-guarded. In v1 `release` splits the payment **equally among `providers[]`** (`amount / providers.length`).

### 8.4 Roles

`api` (backend key), `verifier` (verifier key) and `owner` (deployer) are **immutable per deployment**; they are separate keys. `receipt` is wired once via `setReceipt` on stake and escrow. To change a role, redeploy. The escrow `token` is an ERC-20 (Hedera HTS tokens expose an ERC-20 facade); `MockStable` is used if Hedera test USDC is unusable.

Deploy order: `MockStable` (if needed) → `MeshStake` → `MeshEscrow` → `MeshReceipt` → `stake.setReceipt` → `escrow.setReceipt`.

---

## 9. x402 payment on `POST /api/jobs`

### 9.1 Challenge (no payment header)

`POST /api/jobs` with a valid body and **no** `X-PAYMENT` header → **HTTP 402**, JSON:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "hedera-testnet",
      "maxAmountRequired": "1000000",
      "resource": "https://<api>/api/jobs",
      "description": "Mesh render job",
      "mimeType": "application/json",
      "payTo": "0x…ESCROW_ADDRESS",
      "maxTimeoutSeconds": 120,
      "asset": "0x… or token id",
      "extra": { "jobId": "0x…", "nonce": "0x…" }
    }
  ]
}
```

The server **creates the job in `created` state** and returns its `jobId` in `extra`, so the nonce is the `jobId`. Unpaid `created` jobs expire after 5 minutes.

### 9.2 Paid retry

Client retries the **same body** with header `X-PAYMENT: <base64 payload>`. Server flow:

1. Decode, verify via the facilitator (`X402_FACILITATOR_URL` or in-process).
2. **Replay check:** `nonce`/payment id must be unused; persist before settling.
3. Settle on Hedera; confirm the escrow `Locked` event.
4. Set status `paid`, emit HCS `PAID`, return `200` with the job object and `X-PAYMENT-RESPONSE` header.

### 9.3 Failure cases

| Case | Response |
| --- | --- |
| No/invalid payment | `402` (fresh challenge, same `jobId` if still `created`) |
| Replayed payment | `409` `{"error":"payment_replayed"}` |
| Underpaid | `402` with `error: "insufficient_amount"` |
| Policy denied (agent cap/allowlist) | `403` `{"error":"policy_denied","reason":"…"}` |
| World check failed | `401` `{"error":"world_denied","reason":"expired|cancelled|invalid"}` |

**[TBD-VERIFY]** the exact `scheme`, `network` string, and `asset` for Hedera, and whether the facilitator supports `payTo = contract`. See §14.

---

## 10. REST API

All JSON unless noted. Errors: `{"error":"code","message":"…"}`. Auth for provider endpoints: `Authorization: Bearer <providerToken>` from register.

### 10.1 Requester

| Method + path | Body / response |
| --- | --- |
| `POST /api/jobs` | Create + pay (§9). Body: `{"type":"render","preset":"small","requester":"0x…","worldProof":{…}}` → `402` then `200` Job |
| `GET /api/jobs/:id` | Job object |
| `GET /api/jobs/:id/events` | **Server-Sent Events** stream (§10.4) |
| `GET /api/jobs/:id/tiles/:index` | Raw tile bytes (`application/octet-stream`) |
| `GET /api/jobs/:id/image.png` | Server-side rendered colorized PNG of finished tiles (optional) |
| `GET /api/receipts/:jobId` | Receipt: job hashes + merkleRoot + verdict + tx hashes + HCS sequences + on-chain receipt |
| `GET /api/health` | `{"ok":true,"version":"…","chainId":296}` |

### 10.2 Provider (worker on Misbah's machine)

| Method + path | Body / response |
| --- | --- |
| `POST /api/providers/register` | `{"address","signature","nonce","cores","memoryGb","os","arch","agentVersion","worldProof"}` → `{"providerId","token"}`. Signature = `personal_sign` over `"mesh-register:<nonce>"`. World proof required (§11) |
| `POST /api/providers/heartbeat` | `{"load":0.42,"currentTask":"…|null"}` → `{"ok":true}` (every 5 s) |
| `GET /api/providers/tasks?wait=20` | Long-poll. → `{"tasks":[Task]}` (may be empty after `wait` s) |
| `GET /api/jobs/:id/input` | The exact `job.json` bytes **for that task** (with `tiles` set) |
| `PUT /api/jobs/:id/tiles/:index` | Raw tile bytes; header `X-Tile-Hash: <64 hex>`; response `{"ok":true}`. Uploaded **as each tile finishes**, so the UI fills live |
| `POST /api/jobs/:id/claim` | `{"provider":"0x…","tilesDigest":"0x…","signature":"0x…","tiles":[{"index":0,"tileHash":"…"}]}` |
| `POST /api/jobs/:id/failure` | `{"provider":"0x…","reason":"timeout|crash|hash_mismatch|killed|attestation_missing","logTail":"…"}` |

`Task`:

```json
{
  "taskId": "uuid",
  "jobId": "0x…",
  "type": "render",
  "imageRef": "…",
  "imageDigest": "sha256:…",
  "inputHash": "…",
  "tiles": [0, 2, 4],
  "timeoutSeconds": 120
}
```

Agent rules: pull image, verify the digest matches `imageDigest` **after** pulling (refuse otherwise → failure `hash_mismatch`); `GET input`, verify `inputHash` over the canonical form (§4.1); run; upload tiles; post claim.

### 10.3 Verifier (worker on Misbah's machine)

| Method + path | Body / response |
| --- | --- |
| `GET /api/verifier/pending` | `{"jobs":[{"jobId","imageDigest","inputHash","merkleRoot","tileCount","providers":[…],"sample":{beacon,seed,k,indices},"windowEnd","tileHashes":["…"]}]}` (jobs in `pending` that still need a verdict) |
| `POST /api/verifier/verdict` | `{"jobId","result":"ok|fraud","sample":{…},"fraud":FraudPayload|null,"finalizeTx":"0x…"|null,"fraudTx":"0x…"|null}` |

The verifier signs and sends `finalize` / `postFraud` itself with `VERIFIER_PRIVATE_KEY`, then reports the verdict to the API.
`tileHashes` lets the verifier build Merkle proofs; tile bytes are fetched from `GET /api/jobs/:id/tiles/:index` when needed (only for sampled tiles).

### 10.4 SSE events (`GET /api/jobs/:id/events`)

Each event: `event: <type>\ndata: <json>\n\n`.

| type | data |
| --- | --- |
| `status` | `{"status":"running"}` |
| `tile` | `{"index":17,"owner":"0x…","tileHash":"…","provider":"0x…"}` |
| `progress` | `{"done":37,"total":64}` |
| `claim` | `{"claimTx":"0x…","merkleRoot":"0x…","windowEnd":1730000000}` |
| `sample` | `{"indices":[…],"k":16,"beacon":"0x…"}` |
| `verdict` | `{"result":"ok"}` or `{"result":"fraud","tileIndex":17,"owner":"0x…"}` |
| `settlement` | `{"kind":"released|refunded","tx":"0x…","slashTx":"0x…"}` |
| `error` | `{"code":"…","message":"…"}` |

Stream sends all past events on connect (replay) then live ones. Heartbeat comment every 15 s.

---

## 11. World ID

Two products, one World pick (docs/TRACKS.md section 3):

**IDKit (Proof of Human): provider registration.**
- `POST /api/world/rp-context {action:"register-provider"}` returns `{app_id, rp_id, environment, action, rp_context}` for the browser widget. The RP signature is made on the server (`@worldcoin/idkit-core/signing`); the signing key never leaves it.
- `POST /api/providers/register` carries `worldProof` (the IDKit result). When `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID` and `WORLD_SIGNING_KEY` are set, the server verifies it with `POST {WORLD_VERIFY_BASE_URL}/api/v4/verify/{rp_id}`, **pins the environment** (`WORLD_ENVIRONMENT`; a mismatch is rejected), requires the proof's `action` to match, and stores the nullifier. One nullifier binds to one wallet per action: another wallet gets `401 world_denied` with reason `nullifier_reused`; the same wallet may re-register. The nullifier is consumed only after the wallet signature checks out.
- **Denied path:** missing, invalid or reused proof gives `401 world_denied {reason}`; a World outage gives `503`; in every case **no provider row, no token, nothing on chain**. Reasons: `missing_proof`, `wrong_action`, `wrong_environment`, `invalid_proof`, `no_nullifier`, `nullifier_reused`, `verify_unavailable`.
- The nullifier is registered on `MeshStake` as the provider's bytes32 identity.
- `MESH_DEV_SKIP_WORLD=true` (DEV ONLY) skips all of this and uses a placeholder nullifier.
- Known limit: the proof is not cryptographically bound to the wallet; the wallet signature plus one-time nullifier binding is the mitigation.

**Agent Pass (World IdP device grant): human approval above a spending threshold.** See section 17.

## 12. HCS audit log

One topic (`HCS_TOPIC_ID`). Every message is JSON ≤ 1 KB:

```json
{
  "v": 1,
  "t": "PAID|ASSIGNED|TILE|CLAIM|SAMPLE|VERDICT|SLASH|RELEASE|REFUND|DENIED",
  "jobId": "0x…",
  "ts": 1730000000,
  "data": { }
}
```

- `CLAIM.data` includes `merkleRoot`, `claimTx`, and each provider's `TileClaim` signature (this is how attribution stays auditable, §7.2).
- `SAMPLE.data` includes `beacon`, `seed`, `indices`.
- `VERDICT.data` includes the fraud payload or `ok`.
- The API stores the returned HCS **sequence number** in `job.hcsSequence[]`.

---

## 13. Presets, limits, defaults

| Constant | Value |
| --- | --- |
| `TILE_COUNT_DEFAULT` | 64 |
| `SAMPLE_RATE` | 0.25 |
| `CHALLENGE_WINDOW_SECONDS` | 45 (testnet) |
| `JOB_TIMEOUT_SECONDS` | 120 (adjust per preset) |
| `UNPAID_JOB_TTL_SECONDS` | 300 |
| `HEARTBEAT_SECONDS` | 5 |
| `PROVIDER_OFFLINE_AFTER_SECONDS` | 20 |
| Container `--pids-limit` | 256 |
| Container memory default | `PROVIDER_MEMORY` (4g) |
| Max tile upload | 1 MiB |
| Max input size | 64 KiB |

---

## 14. Open items to verify (do not guess)

| Item | Owner | Where to check |
| --- | --- | --- |
| Hedera x402 `scheme`, `network` string, `asset`, and whether the facilitator supports `payTo = contract` | Anurag | `docs.hedera.com/solutions/ai/x402` (+ `/facilitators`, `/exact-scheme`) |
| Which facilitator we use (Official x402 / Ax402 / Blocky402 / own) | Anurag | same |
| ~~Does `sha256()` precompile behave as expected on Hedera EVM~~ **Resolved 2026-11-05:** on-chain `computeLeaf` matches an independent SHA-256 | Anurag | docs/DEPLOY.md |
| 0G: how the signature/attestation is returned, signer address, and what is signed | Misbah | `pc.0g.ai`, `docs.0g.ai` |
| World: IDKit vs Agent Pass pick and exact verify endpoint/params | Anurag | `docs.world.org`, `auth.world.org/docs` |
| Whether `X-PAYMENT` base64 payload carries the nonce we need | Anurag | x402 spec / `x402` package source |

---

## 15. Golden test vectors

Both sides commit golden files and test against each other:

- `docs/golden/hash.json`: SHA-256 of `""` and `"abc"` plus a handful of tile-hash/leaf/node/Merkle-root examples (generated by Misbah's `src/lib` implementation, verified by Anurag's Solidity test).
- `docs/golden/render-tiny.json`: `tileHash` of every tile of the `tiny` preset, produced by Misbah's image, reproduced on **both** operating systems.
- `docs/golden/sample.json`: a `(jobId, merkleRoot, beacon)` → `indices` example to prove both sides derive the same sample.
- `docs/golden/claim.json`: one EIP-712 `TileClaim` with its signature, verified by the API.

Rule: a spec change that alters any golden file requires both people to re-run their tests.

---

## 16. Who implements what

| Piece | Owner |
| --- | --- |
| Render/matmul engines, Dockerfiles, image digests | Misbah |
| `src/lib` hashing, Merkle, sampling (shared helpers) | Misbah writes; Anurag reviews against §7 |
| Provider worker (tasks, tiles upload, claim signing) | Misbah |
| Verifier worker (sample recompute, `finalize`/`postFraud`) | Misbah |
| 0G `infer` job + signature details | Misbah |
| Contracts (§8) and deploy | Anurag |
| API routes, matcher, x402, World verify, HCS publisher | Anurag |
| Frontend, scripted agent | Anurag |

---

## 17. Human approvals (World Agent Pass)

Spending control for the autonomous agent: a job priced above `AGENT_APPROVAL_THRESHOLD` (smallest token unit) needs a fresh human approval. Jobs at or below the threshold need none; an unset threshold means no approvals.

1. `POST /api/approvals` with the same body as `POST /api/jobs` (`type`, `preset`, `requester`) returns `201 {approvalId, status:"pending", userCode, verificationUri, expiresAt, interval, params}`. The human opens `verificationUri` / enters `userCode` in the World app. The device code stays on the server.
2. `GET /api/approvals/:id` returns the status (`pending | approved | denied | expired | used`) and polls World no more often than `interval` (adding 5 s on `slow_down`).
3. The agent retries `POST /api/jobs` with header `X-Mesh-Approval: <approvalId>`.

**Rules (all tested):**
- Only a **validated ID token** approves: RS256 against the issuer's JWKS, exact `iss`, `aud` = our client id, `exp`, `acr` in `WORLD_IDP_ALLOWED_ACR` (default Orb), `amr` includes `pop`, and `auth_time` within `AGENT_APPROVAL_MAX_AGE_SECONDS` (default 300). A token that fails validation **denies** the approval.
- World outage, 429, network error: the approval stays **pending**; it is never approval. `access_denied` gives `denied`; `expired_token` / `invalid_grant` give `expired`.
- The approval is **bound by hash to the exact action** (requester, type, preset, price) and is **single use**. Another preset, price or requester gives `binding_mismatch`; reuse gives `already_used`.
- **Denied path:** no header gives `403 approval_required`; a pending, denied, expired, spent, mismatched or unknown approval gives `403 approval_denied {reason}`. In every case **no job is created and nothing is paid**.
- A spent approval is recorded as an `approval` event on the job.
- Needs a confidential OIDC client from `auth.world.org/portal`: `WORLD_IDP_CLIENT_ID`, `WORLD_IDP_CLIENT_SECRET` (SECRET), `WORLD_IDP_ISSUER` (default `https://auth.world.org`).
