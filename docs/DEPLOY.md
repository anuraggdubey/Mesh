# Deploying the contracts to Hedera testnet

Contracts: `contracts/src` (`MeshStake`, `MeshEscrow`, `MeshReceipt`, `MockStable`). Tests: `contracts/test` (67 tests). Deploy script: `contracts/script/Deploy.s.sol`.

## One-time prerequisites (you do these, not the AI)

1. **Foundry** installed. On this machine it lives in `C:\Users\dubey\.foundry\bin`. In Git Bash:
   `export PATH="$PATH:/c/Users/dubey/.foundry/bin"` (or add that folder to your user PATH).
2. **Three Hedera testnet accounts with ECDSA keys** (Hedera's EVM needs ECDSA, not ED25519). Create them at https://portal.hedera.com (testnet) and fund each with testnet HBAR from the portal's faucet:
   - **deployer** (also becomes the contract `owner`)
   - **api** (the backend key; calls `lock`, `postClaim`, `registerProvider`, `postAttested`)
   - **verifier** (calls `postFraud`)
   - plus at least one **provider** wallet and one **requester** wallet for testing.
   Use the account's **hex EVM private key** (0x…) and its **EVM address**.
3. Put the values in `.env` (never commit it): `DEPLOYER_PRIVATE_KEY`, `API_ADDRESS`, `VERIFIER_ADDRESS`, and optionally `OG_SIGNER_ADDRESS`, `PAYMENT_TOKEN_ADDRESS`.

## Deploy

```bash
cd contracts
export PATH="$PATH:/c/Users/dubey/.foundry/bin"
set -a; source ../.env; set +a      # loads DEPLOYER_PRIVATE_KEY, API_ADDRESS, VERIFIER_ADDRESS
forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --broadcast
```

The script prints `PAYMENT_TOKEN_ADDRESS`, `STAKE_ADDRESS`, `ESCROW_ADDRESS`, `RECEIPT_ADDRESS`. Copy them into `.env.example` (addresses are public) and your local `.env`.

If Hedera's JSON-RPC rejects the gas estimate, add `--legacy` and/or `--gas-price` / `--slow` to the command.

## Tunable settings (env, with defaults)

`WINDOW_SECONDS=45`, `MIN_STAKE_WEI=1e18`, `SLASH_AMOUNT_WEI=5e17`, `UNLOCK_DELAY_SECONDS=300`, `REFUND_AFTER_SECONDS=3600`. On Hedera the native unit is 8 decimals in tinybars at the SDK level but 18 decimals through the EVM/JSON-RPC (`msg.value`), so `1 ether` in the contracts means 1 HBAR.

## Verify on testnet (smoke checks)

1. `cast call <RECEIPT> "computeLeaf(uint16,bytes32,address)(bytes32)" 5 0x…2a <addr> --rpc-url https://testnet.hashio.io/api` should equal `sha256(0x00 || 0x0005 || tileHash || addr)`. This confirms the `sha256` precompile behaves on Hedera's EVM (spec §14 open item).
2. Register + stake a provider, mint `MockStable` to the escrow, `lock`, `postClaim`, wait past the window, `finalize`: provider receives the payment.

## Local rehearsal (no testnet needed)

```bash
anvil --port 8545 &
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # public anvil test key
export API_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 VERIFIER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

## Known v1 limits (also in the README)

- The API key attributes tiles to providers; provider signatures are published to the audit log, not checked on chain.
- The verifier key supplies the "expected" tile hash in a fraud proof.
- `ogSigner` and the exact 0G signed-message format are unconfirmed; `postAttested` uses EIP-191 over the 32-byte digest.

---

## Deployed (Hedera testnet, chain 296, 2026-11-05)

| Contract | Address | HashScan |
| --- | --- | --- |
| MockStable (payment token) | `0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3` | https://hashscan.io/testnet/contract/0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3 |
| MeshStake | `0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8` | https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8 |
| MeshEscrow | `0x16eFE46De1CdA06Be455607A63514319aE130010` | https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010 |
| MeshReceipt | `0x0118652ea87a8616Cb51979F5F121FC598bf3e7E` | https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E |

Roles: deployer/owner `0x6834228cb6F180C05fA2154a2B2670d92c4FDf59`, api `0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645`, verifier `0x74ACEf1A77aC2120aDFb19ca27A134e54A423A4e`.
Settings: window 45 s, min stake 0.5 HBAR, slash 0.2 HBAR, unstake delay 300 s, public refund after 3600 s.

Deployed with `forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --legacy --slow --broadcast` (optimizer runs = 1). The whole deploy cost about 5.4 HBAR.

Verified on chain after deploy: bytecode present at all four addresses; stake and escrow point at the receipt contract; roles and settings read back correctly; **the `sha256` precompile on Hedera produces the same leaf hash as an independent `sha256sum`** (spec §14 item resolved).

The ABIs live in `src/lib/abi/*` and the addresses in `src/lib/contracts.ts`. If contracts are redeployed, regenerate both and update `.env` / `.env.example`.
