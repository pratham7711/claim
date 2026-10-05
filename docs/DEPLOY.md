# Deploying Claim!

Claim! is one long-running Node process (`next start` for `apps/web`):
- every show's state lives in that process's memory;
- every engine event is appended to `<CLAIM_DATA_DIR>/<showId>.jsonl`;
- browsers get live updates over server-sent events.

So it needs **one always-on instance with a persistent disk**. Nothing in this document has been deployed. The host-specific sections are instructions written from the code's requirements, **unverified on each host**. Only the Docker image itself was run and checked.

## The Docker image

`Dockerfile` (repo root) has four stages:
1. `npm ci`;
2. `next build` inside the image;
3. production-only `node_modules`;
4. a runtime on `node:26-bookworm-slim`.

The runtime runs as the non-root `node` user (uid 1000), listens on `$PORT` (default 3011), and writes its log to `CLAIM_DATA_DIR=/data`, which is declared as a volume.

```bash
docker build -t claim-web .
docker run --rm -p 3011:3011 -v claim-data:/data claim-web
# open http://localhost:3011
```

**Measured on 2026-10-05** (Docker on macOS, linux/arm64 image, rebuilt from the tree as of about 14:10 UTC):

| Check | Result |
|---|---|
| Build | succeeded |
| Image size | 895 MB disk usage; 210 MB content size (`docker images`) |
| Startup | `next start` logs "Ready in 45ms" |
| `curl http://localhost:3013/` (port mapped `-p 3013:3011`) | `200`, landing page HTML |
| `POST /api/shows {"seed":true}` | `201 {"showId":"show-…"}` |
| `GET /api/shows/<id>/stream` | `text/event-stream`, an initial `snapshot` event |
| Writes to `/data` | as uid 1000 |
| Restart with the same named volume | the show reloads from its log unchanged: 28 comments, 5 carts with the same statuses, 1 refund and 1 tracker before and after. The log file is owned by uid 1000. |
| Full demo flow over the API (race, late comment, bundle, slang, Hinglish, end, charge, pay-now, refund, tracking) | every step returned 200; outcomes as in [DEMO-SCRIPT.md](DEMO-SCRIPT.md) |

**Health check.** There is no dedicated health route. `GET /` returns 200 when the server is up.

## Rules for any host

1. **Exactly one instance per data directory.** Two instances would each keep their own copy of a show and could both grant the last unit; see [ARCHITECTURE.md](ARCHITECTURE.md#5-why-single-process). Turn off autoscaling and set the replica count to 1.
2. **Mount a persistent volume at `/data`** (or set `CLAIM_DATA_DIR` to the mount path). Without one, a redeploy wipes every show.
3. **Keep the instance running.** Scale-to-zero or auto-stop drops open SSE connections and the 1-second lease clock. Engine state survives a restart, because it replays from the log, but in-flight simulations, Twitch connections and pay-now holds' timers only resume once the show is loaded again.
4. **Allow long-lived responses.** `/api/shows/<id>/stream` stays open, with a comment ping every 15 s. The route already sends `x-accel-buffering: no` and `cache-control: no-cache, no-transform`. A proxy with a short idle timeout or response buffering will break live updates.
5. **Volume ownership.** The process runs as uid 1000.
   - A Docker named volume inherits `/data`'s ownership from the image; this was measured.
   - A host bind mount, or a platform volume that mounts root-owned, will make every append fail with `EACCES`. The fix is a one-time `chown -R 1000:1000` on the mount, or pointing `CLAIM_DATA_DIR` at a writable directory on the volume. Unverified per host.

## Fly.io (unverified)

```bash
fly launch --no-deploy                  # detects the Dockerfile; pick a region, no Postgres/Redis
fly volumes create claim_data --size 1  # one volume, so one machine
```

Then in `fly.toml`:

```toml
[env]
  CLAIM_DATA_DIR = "/data"

[mounts]
  source = "claim_data"
  destination = "/data"

[http_service]
  internal_port = 3011
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1
```

```bash
fly deploy
fly scale count 1
```

Fly volumes may mount root-owned. If the logs show `EACCES` on `/data/*.jsonl`, run `fly ssh console -C "chown -R 1000:1000 /data"` once (unverified).

## Render

The repo carries a Blueprint, `render.yaml`: one Docker web service on the **free** plan.

- In Render, **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`.
- It asks for `GROQ_API_KEY`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (marked `sync: false`, so they never live in the repo). `LLM_PROVIDER=groq` is set by the Blueprint.
- Render provides `PORT`, and the container honours it.
- The free plan has no persistent disk and sleeps after 15 minutes without traffic; the first request after that waits for a cold start. Show logs under `/data` last only as long as the instance, which is fine for demos because each demo show is seeded fresh.
- For shows that must survive a restart, move to a paid instance, add a **Disk** at `/data`, and keep the instance count at 1 (a disk belongs to one instance).

## Railway (unverified)

- Deploy from the repo. Railway builds the root `Dockerfile`.
- Add a **Volume** mounted at `/data`, and keep replicas at 1.
- Railway injects `PORT`. The image's start command uses `${PORT:-3011}`, so no change is needed.

## Any VM (unverified)

```bash
docker build -t claim-web .
docker run -d --name claim --restart unless-stopped \
  -p 127.0.0.1:3011:3011 -v claim-data:/data \
  --env-file /etc/claim.env claim-web
```

Put Caddy or nginx in front for TLS. nginx honours `x-accel-buffering: no`, but give `/api/shows/` a long `proxy_read_timeout`, because the stream pings every 15 s.

## Why Vercel serverless does not work as-is

The app type-checks and builds on Vercel's runtime, but its design assumes one long-lived process:

1. **State is in memory.** `apps/web/lib/server.ts` keeps every show on `globalThis.__claimShows`.
   - Serverless runs many short-lived instances. Two requests for the same show can land on two instances with different state; that means double grants and a broken fairness order.
   - An idle instance is reclaimed, and the show is reclaimed with it.
2. **SSE needs the same process as the writer.** `/api/shows/<id>/stream` subscribes a listener in the instance that serves it. A claim handled by another instance never reaches that listener, and functions have a maximum duration, so the stream is cut.
3. **The event log is a local file.** `createFileStore` calls `appendFileSync` under `process.cwd()/.data` (or `CLAIM_DATA_DIR`). Vercel's filesystem is read-only apart from a per-instance, ephemeral `/tmp`. So the log is either refused or lost, and other instances never see it.
4. **Background work stops after the response.** The 1-second `tick` that expires pay-now holds, the `setTimeout`-scheduled simulator comments and the Twitch WebSocket all run after a request has returned. Serverless functions are frozen or reclaimed at that point.

Making it serverless would take three changes, none implemented:
- a single writer per show;
- a shared durable event log in place of the JSONL file;
- a pub/sub channel for the SSE fan-out, plus a scheduled job or queue for lease expiry.

## Environment variables

All are optional. With none set, the app runs rules-only resolution and mock payments.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3011` | Listen port (`next start -p`). |
| `CLAIM_DATA_DIR` | `/data` in the image; `apps/web/.data` for `npm run dev` / `npm start` (it is `process.cwd()/.data`) | Where `<showId>.jsonl` logs are written. |
| `LLM_PROVIDER` | `mock` | `anthropic`, `openai`, `groq`, `gemini`, `openai-compat`, `claude-cli` or `mock`. `mock` means rules only; no LLM call is made. |
| `LLM_MODEL` | provider default (`claude-haiku-4-5`, `gpt-4.1-mini`, `openai/gpt-oss-20b`, `gemini-2.5-flash-lite`, `haiku` for claude-cli) | Model override. |
| `LLM_TIMEOUT_MS`, `LLM_RETRIES` | adapter defaults | HTTP timeout and retries for the LLM client. The resolver also aborts a batch after 20 s and keeps the rule answers. |
| `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`) | none | Required for `anthropic`. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` | none | Required for `openai` / `groq` / `gemini`. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_JSON_MODE` | none | For `openai-compat` (base URL and key are required). `LLM_BASE_URL` and `LLM_JSON_MODE` also override the openai, groq and gemini presets. |
| `LLM_REASONING_EFFORT` | `low` for groq, unset otherwise | `low`, `medium` or `high`, sent as `reasoning_effort` to reasoning models such as gpt-oss. |
| `LLM_FALLBACK_MODELS` | groq: `qwen/qwen3.8-27b,openai/gpt-oss-120b` | Comma list of models to try, in order, when the current one answers 429. Rate limits are per model, so this spreads the free tier. A model that hit its limit is skipped until its `Retry-After` passes; when every model is limited the comment goes straight to review. An empty value turns fallback off. |
| `CLAUDE_BIN`, `CLAUDE_THINKING` | `claude`, off | For `claude-cli`. It spawns the local Claude Code CLI, which is **not in the Docker image**, so do not use it in a container. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | none | When **both** are set, the app switches from the mock to the PayPal **sandbox** gateway. |
| `PAYPAL_WEBHOOK_ID` | none | Needed by `verifyWebhook`. No route calls it yet. |
| `PAYPAL_GATEWAY` | unset | `mock` forces the mock even when credentials are set. |
| `PAYPAL_STORED_CREDENTIAL` | on | `false`, `0`, `off` or `no` drops `stored_credential` from vault orders (whether PayPal requires it is unverified). |
| `PAYPAL_BASE_URL` | `https://api-m.sandbox.paypal.com` | Any non-sandbox host is refused. |
| `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` | `production`, `1` (set in the image) | |

**Where to put them.**
- In a container or on a host, pass them as real environment variables (`docker run -e` / `--env-file`, or the platform's settings).
- For local `npm run dev`, export them in the shell. Next.js reads `.env*` files from `apps/web/`, not from the repo root (standard Next.js behaviour, not exercised in this repo: unverified). The repo-root `.env` is read only by the PayPal spike script.

**Keep public demos on the mock.** Setting the PayPal credentials switches the whole app to sandbox, and two things change:
- the buyer room's Claim Pass sheet loads PayPal's v6 save session (`clientToken`, then `passSetup`, then `passApprove`), which has not been run against a live sandbox;
- simulated buyers get no Claim Pass. Their grants become pay-now holds, so the scripted decline and the simulated Claim Pass charges do not happen.

Also, no route has authentication, so anyone with a show URL can act as the seller.

## PayPal webhook URL

**The web app has no webhook route yet.** There is no `/api/paypal/webhook` under `apps/web/app`. `@claim/paypal` provides the pieces:
- `verifyWebhook(headers, rawBody)`, which posts to `/v1/notifications/verify-webhook-signature`;
- `registerWebhook(url)`;
- `WEBHOOK_EVENTS`.

When a route exists, set it up like this. The steps follow `packages/paypal/README.md` and are unverified.

1. Deploy to a public **HTTPS URL on port 443**. PayPal cannot deliver to localhost.
2. On developer.paypal.com, open the sandbox app, then **Sandbox Webhooks**, then **Add Webhook**, with URL `https://<your-host>/api/paypal/webhook`. Subscribe to:
   - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`;
   - `CHECKOUT.ORDER.APPROVED`;
   - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`.

   The spike can also register it: `SPIKE_WEBHOOK_URL=https://<your-host>/api/paypal/webhook npx tsx packages/paypal/scripts/spike.ts`.
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` and restart.
4. The route must:
   - read the body as raw text (`await req.text()`), not parsed JSON, and pass it with the request headers to `verifyWebhook`;
   - answer `400` when that returns `false`;
   - answer `5xx` when it throws (a PayPal outage), so PayPal redelivers.

   PayPal's simulator events cannot be postback-verified; use real sandbox events.
