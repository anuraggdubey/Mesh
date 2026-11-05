# Hedera integration debrief (x402, HCS, EVM)

Fill the timings in as we run live. Judges read it. Be specific and honest.

- **What we use:** x402 v2 on `hedera:testnet` (`@x402/core`, `@x402/hedera`), HBAR as the payment asset (HTS USDC supported), the public facilitator, HCS for the audit log (`@hiero-ledger/sdk`), the mirror node for account lookup, and Hedera's EVM (Hashio JSON-RPC) for the stake, escrow and receipt contracts.
- **Time to first settled x402 payment:** _(record after the first live run)_
- **Settled payment transaction ID:** _(paste after the first live run)_
- **Friction so far (code only, before a live run):**
  - The x402 client rejects HBAR by default. Its spend controls only allow a built-in list of assets, so a client paying in HBAR needs `spendControls.allowedAssets` set explicitly.
  - The `exact` scheme on Hedera has no per-request nonce (the payment is a signed `cryptoTransfer`), so a server has to remember served payments itself to stop replay. We store a hash of the signed transaction.
  - `payTo` must be a Hedera account id, not an EVM contract address, so an x402 payment cannot go straight into an EVM escrow. We settle to a treasury account and mirror the payment into escrow (option B in docs/TRACKS.md 2.4).
  - An ECDSA key's account is not known from the key alone; we resolve it from the EVM address through the mirror node (this fails until the address has received HBAR once).
  - Our `.env.example` said `hedera-testnet`; the network id the packages use is `hedera:testnet`.
- **What worked well:** the facilitator pays the network fee, so the paying agent needs no fee logic; the 402 / retry shape is plain HTTP.
- **Missing capability or documentation:** _(fill in after the live run)_
- **The one improvement with the greatest impact:** a documented way for an EVM contract to receive an x402 payment, so escrow does not need a mirror step.
- **HCS:** every job event that matters (paid, assigned, claim, sample, verdict, slash, release, refund, approval) is published to one topic with a submit key; sequence numbers are stored on the job and returned by the receipt endpoint.
