# rickcedrabbit

A self-hosted AI code reviewer powered by Claude. Reviews PRs, plans issues, tracks spend. Runs as a Cloudflare Worker.

## What it does

- Posts AI reviews on pull requests when triggered via checkbox or `@rickcedwhat-ai review`
- Sets a `ai-review` commit status (pass/fail) based on whether the review found blocking issues
- Tracks spend per-repo and globally with configurable limits
- Generates implementation plans on issues via `@rickcedwhat-ai plan`
- Per-repo config via `.bot-review.yaml`

## Setup

### 1. Prerequisites

- [Cloudflare account](https://cloudflare.com) (free tier works)
- [Upstash Redis](https://upstash.com) database (free tier works)
- [Upstash QStash](https://upstash.com/qstash) (free tier works — used for reminder scheduling)
- [Anthropic API key](https://console.anthropic.com)
- A GitHub bot account (e.g. `yourname-ai`) with a classic PAT

### 2. Deploy the worker

```bash
git clone https://github.com/rickcedwhat-ai/rickcedrabbit
cd rickcedrabbit
npm install
npx wrangler deploy
```

Set secrets (run each line separately, you'll be prompted to paste the value):

```bash
npx wrangler secret put BOT_PAT
npx wrangler secret put WEBHOOK_SECRET        # any random string, you'll use this in step 3
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put UPSTASH_REDIS_REST_URL
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN
npx wrangler secret put QSTASH_TOKEN
npx wrangler secret put QSTASH_CURRENT_SIGNING_KEY
npx wrangler secret put QSTASH_NEXT_SIGNING_KEY
```

After deploy, Wrangler will print your worker URL: `https://rickcedrabbit.<your-subdomain>.workers.dev`

### 3. Add the webhook

**Option A — Account-level (recommended for personal use):**
Go to GitHub → Settings → Webhooks → Add webhook
- Payload URL: `https://rickcedrabbit.<your-subdomain>.workers.dev/webhook`
- Content type: `application/json`
- Secret: the value you used for `WEBHOOK_SECRET`
- Events: select **Pull requests**, **Issue comments**, **Pull request reviews**, **Issues**

This covers all your repos automatically. No per-repo setup needed.

**Option B — Per-repo:**
Same settings, but added under a specific repo's Settings → Webhooks.

### 4. Add the required status check (optional but recommended)

In your repo's branch ruleset, add `ai-review` as a required status check. New PRs will need the bot to sign off before merging.

### 5. Per-repo config (optional)

Copy `.bot-review.yaml.example` to `.bot-review.yaml` in any repo's root and customize. The bot fetches this on every review — no redeployment needed.

---

## Triggering a review

In any PR:
- Edit the Bot HQ comment and check one of the three checkboxes
- Or comment `@rickcedwhat-ai review`

For issue planning:
- Comment `@rickcedwhat-ai plan`

## Spend limits

Default limits (override via `wrangler secret put` or `wrangler.toml` vars):

| Limit | Default |
|---|---|
| Per-repo daily | $1.00 |
| Global daily | $5.00 |
| Global monthly | $10.00 |

When a limit is hit, the bot posts an explanatory comment and sets the commit status to `failure`. Counters reset automatically (daily keys expire after 48h, monthly after 62 days).

## Adding another repo (self-hosted)

Each person runs their own instance with their own API keys and spend limits. Fork/clone the repo, follow the setup steps above. The bot account is optional — you can use your own account's PAT if you prefer.

## Development

```bash
npm install
npm test          # vitest unit tests
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev (local)
```
