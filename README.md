# Chesso (LUKSO PvP Chess)

LUKSO-powered PvP chess with:
- Universal Profile wallet login
- Realtime off-chain game server (`chess.js` authoritative)
- Optional Redis persistence
- On-chain escrow staking contract (native + LSP7)
- In-game chat with username onboarding

## Project structure

- `/Users/adamerbs/Documents/Chesso/apps/web` - React client
- `/Users/adamerbs/Documents/Chesso/apps/server` - websocket game server
- `/Users/adamerbs/Documents/Chesso/contracts` - Hardhat contract project

## 1) Install

```bash
cd /Users/adamerbs/Documents/Chesso
npm install
npm install --prefix contracts
```

## 2) Configure env

### App env

```bash
cp .env.example .env
```

Set at least:

```env
VITE_WS_URL=ws://localhost:8080
VITE_ESCROW_ADDRESS=0xYourDeployedStakeEscrowAddress
VITE_POTATO_TOKEN_ADDRESS=0xYourPotatoLSP7TokenAddress
VITE_CHESS_TOKEN_ADDRESS=0xYourChessLSP7TokenAddress
VITE_STAKING_ENABLED=false
PORT=8080
DISCONNECT_FORFEIT_MS=60000
GAMESTORE_TYPE=memory
REDIS_URL=redis://localhost:6379
REDIS_KEY_PREFIX=chesso:room:
CLOCK_INITIAL_MS=300000
CLOCK_INCREMENT_MS=2000
```

### Contract deploy env

```bash
cp /Users/adamerbs/Documents/Chesso/contracts/.env.example /Users/adamerbs/Documents/Chesso/contracts/.env
```

Set:

```env
PRIVATE_KEY=0x...
LUKSO_RPC_URL=https://...
ARBITER_ADDRESS=0x...
FEE_RECIPIENT_ADDRESS=0x...
PROTOCOL_FEE_BPS=500
LOCK_WINDOW_SECONDS=900
```

## 3) Compile/test/deploy escrow contract

```bash
npm run build:contracts
npm run test:contracts
npm run deploy:contracts
```

Copy deployed address into `VITE_ESCROW_ADDRESS` in `/Users/adamerbs/Documents/Chesso/.env`.

## 4) Run app

```bash
npm run dev:server
npm run dev:web
```

Open [http://localhost:5173](http://localhost:5173).

## 5) E2E button tests (Playwright)

Install Playwright dependency and browser:

```bash
npm install
npx playwright install
```

Run end-to-end tests:

```bash
npm run test:e2e
```

Run headed mode:

```bash
npm run test:e2e:headed
```

## Redis persistence (optional)

```bash
docker run --name chesso-redis -p 6379:6379 redis:7
```

Then set in `.env`:

```env
GAMESTORE_TYPE=redis
REDIS_URL=redis://localhost:6379
```

## Core game protocol

Client -> server websocket message types:
- `create_room` `{ address }`
- `join_room` `{ roomId, address }`
- `resume_room` `{ roomId, address }`
- `make_move` `{ roomId, from, to, address }`
- `offer_draw` `{ roomId, address }`
- `accept_draw` `{ roomId, address }`
- `resign` `{ roomId, address }`
- `offer_rematch` `{ roomId, address }`
- `enter_chat` `{ roomId, address, username }`
- `send_chat` `{ roomId, address, text }`

Server -> client:
- `game_state` with board, clock, move history, chat, connection status
- `error` with `message`

## Staking flow (UI)

1. Both players join room.
2. Click `Create Escrow Match`.
3. Each player clicks `Lock My Stake`.
   - For `Native LYX`: wallet prompts native value transfer via escrow call.
   - For `LSP7 Token` (`POTATO`, `$CHESS`, or custom): wallet first prompts token transfer to escrow, then lock confirmation.
4. Play game.
5. After result, arbiter wallet clicks `Settle Winner`.
   - Settlement sends winner payout minus protocol fee.
   - Protocol fee is configured at deploy time via `PROTOCOL_FEE_BPS` and `FEE_RECIPIENT_ADDRESS`.
6. If one player never locks and lock window expires, locked player clicks `Refund Expired Stake`.

Staking safety toggle:
- Set `VITE_STAKING_ENABLED=true` only when you are ready to run escrow in beta.
- Keep `false` for non-staking environments.

## Chat flow (UI)

- Chat auto-connects from UP profile.
- Messages can be sent immediately in-room.
- Avatar/username are pulled from profile where available.

## Beta deployment (Vercel + game server)

Vercel should host only the web app. The websocket game server must run separately (Railway/Render/Fly/VM).

### A) Deploy web on Vercel

1. Create a Vercel project.
2. Set **Root Directory** to `/Users/adamerbs/Documents/Chesso/apps/web`.
3. Build settings:
   - Build command: `npm run build`
   - Output directory: `dist`
4. Add environment variables in Vercel (Production + Preview):

```env
VITE_WS_URL=wss://YOUR-GAME-SERVER-DOMAIN
VITE_ESCROW_ADDRESS=0xYourDeployedStakeEscrowAddress
VITE_POTATO_TOKEN_ADDRESS=0xYourPotatoLSP7TokenAddress
VITE_CHESS_TOKEN_ADDRESS=0xYourChessLSP7TokenAddress
VITE_PROTOCOL_FEE_BPS=500
VITE_FEE_RECIPIENT_ADDRESS=0x6230143Fe178d1C790748cFB03C544166Bf0c86a
VITE_STAKING_ENABLED=true
```

`apps/web/vercel.json` is included in this repo for Vite output config.

### B) Deploy game server

Run `@chesso/server` as a separate service and expose port `8080`:

```bash
cd /Users/adamerbs/Documents/Chesso
npm install
npm run dev:server
```

For production start:

```bash
cd /Users/adamerbs/Documents/Chesso
npm install
npm run start --workspace @chesso/server
```

Set server env in the host platform:

```env
PORT=8080
DISCONNECT_FORFEIT_MS=60000
GAMESTORE_TYPE=redis
REDIS_URL=redis://...
REDIS_KEY_PREFIX=chesso:room:
CLOCK_INITIAL_MS=300000
CLOCK_INCREMENT_MS=2000
```

### C) Beta smoke test checklist

1. Connect two different UP wallets.
2. Create stake offer and confirm wallet transfer prompt appears.
3. Open offer link with second wallet and accept.
4. Confirm second wallet transfer prompt appears.
5. Verify game starts with creator as white and accepter as black.
6. Verify chat sends immediately and activity list does not overlap.
7. Finish game and settle winner payout.
8. Verify 5% fee is routed to `0x6230143Fe178d1C790748cFB03C544166Bf0c86a`.

## Production notes

Current build is MVP-grade. Before real money launch:
- formal security audit
- signed move proofs for dispute resolution
- stricter server auth/rate limits and anti-spam for chat
- independent monitoring/alerts for escrow and game services
