# Hosting the API

The app is a Next.js server with a SQLite database and a background chain loop. It needs Node.js 24, a disk that persists, and one long-running process. A serverless host (for example Vercel) does not fit.

## Temporary: a Cloudflare quick tunnel (development and rehearsals)

Runs on your own machine and gives a public HTTPS address. The address changes each time and Cloudflare can drop it without warning, so do not use it for the submission.

```bash
winget install Cloudflare.cloudflared
npm run build
npm start -- -p 3100
cloudflared tunnel --url http://localhost:3100
```

Put the printed `https://….trycloudflare.com` address in `.env` as `API_PUBLIC_URL` and restart the server. Providers, the verifier and the agent use that address.

## Permanent: Railway

1. Sign in at railway.com with GitHub. **New Project, Deploy from GitHub repo**, choose this repository.
2. **Settings, Networking, Generate Domain.** Copy the `https://….up.railway.app` address.
3. **Settings, Volumes:** add a volume mounted at `/data`.
4. **Variables, RAW Editor:** paste the variables for the server (see below), with `DATA_DIR=/data` and `API_PUBLIC_URL=<the Railway address>`.
5. Build command `npm run build`, start command `npm start`. Check `https://<address>/api/health`.

### Variables the server needs

Required: `API_PRIVATE_KEY`, `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID`, `RECEIPT_ADDRESS`, `STAKE_ADDRESS`, `ESCROW_ADDRESS`, `PAYMENT_TOKEN_ADDRESS`, `VERIFIER_ADDRESS`, `RENDER_IMAGE_REF`, `RENDER_IMAGE_DIGEST`, `API_PUBLIC_URL`, `DATA_DIR`, `MESH_CHAIN_LOOP=true`.

Payments: `X402_ENABLED=true`, `X402_NETWORK`, `X402_ASSET`. Audit log: `HCS_TOPIC_ID`. World: `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY`, `WORLD_ENVIRONMENT`, and `AGENT_APPROVAL_THRESHOLD`. 0G: `OG_API_KEY`, `OG_API_BASE_URL`, `OG_MODEL`, `OG_ENABLED`.

Do **not** put these on the server: `DEPLOYER_PRIVATE_KEY`, `VERIFIER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, `PROVIDER_PRIVATE_KEY`. The agent, providers and verifier run elsewhere and point at the hosted address (`MESH_API_URL` or `API_PUBLIC_URL`).

The three `MESH_DEV_*` switches must stay off on a public server.
