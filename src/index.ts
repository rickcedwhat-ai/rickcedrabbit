import { Hono } from 'hono';
import { Receiver } from '@upstash/qstash';
import { GitHubClient } from './lib/github.js';
import { StateManager } from './lib/state.js';
import { handlePullRequest, handleIssueComment, handlePullRequestReview } from './handlers/webhook.js';
import { handleIssue, handleIssueComment as handleIssueCommentPlain } from './handlers/issue.js';
import { handleCoordinator } from './handlers/coordinator.js';

export interface Env {
  BOT_PAT: string;
  WEBHOOK_SECRET: string;
  QSTASH_TOKEN: string;
  QSTASH_CURRENT_SIGNING_KEY: string;
  QSTASH_NEXT_SIGNING_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  // Optional: comma-separated allowlist e.g. "rickcedwhat/my-repo,rickcedwhat/other"
  // If unset, any repo sending a valid webhook is processed.
  ALLOWED_REPOS?: string;
  // Optional: issue number for the spend dashboard
  DASHBOARD_ISSUE?: string;
  // AI review
  REVIEW_PROVIDER: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  REVIEW_MODEL_OVERRIDE?: string;
  // Spend limits (USD) — defaults: repo $1/day, global $5/day, $10/month
  SPEND_LIMIT_REPO_DAILY?: string;
  SPEND_LIMIT_GLOBAL_DAILY?: string;
  SPEND_LIMIT_GLOBAL_MONTHLY?: string;
}

async function verifyGitHubSignature(secret: string, body: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return signature === expected;
}

async function verifyQStashSignature(
  currentKey: string,
  nextKey: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });
  try {
    await receiver.verify({ signature: signatureHeader, body });
    return true;
  } catch {
    return false;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({ ok: true, version: '1.0.0' });
});

app.post('/webhook', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256') ?? '';
  const event = c.req.header('X-GitHub-Event') ?? '';

  const valid = await verifyGitHubSignature(c.env.WEBHOOK_SECRET, body, signature);
  if (!valid) return c.json({ error: 'Invalid signature' }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  const repo: string = p.repository?.full_name ?? '';
  if (!repo) return c.json({ ok: true });

  if (c.env.ALLOWED_REPOS) {
    const allowed = c.env.ALLOWED_REPOS.split(',').map((r: string) => r.trim());
    if (!allowed.includes(repo)) return c.json({ ok: true });
  }

  const github = new GitHubClient(c.env.BOT_PAT, repo);
  const state = new StateManager(c.env.UPSTASH_REDIS_REST_URL, c.env.UPSTASH_REDIS_REST_TOKEN);
  const action: string = p.action ?? '';
  const ctx = { github, state, env: c.env, event, payload };

  try {
    if (event === 'pull_request' && (action === 'opened' || action === 'synchronize')) {
      await handlePullRequest(ctx);
    } else if (event === 'issue_comment' && (action === 'created' || action === 'edited')) {
      if (p.issue?.pull_request) {
        await handleIssueComment(ctx);
      } else {
        await handleIssueCommentPlain(ctx);
      }
    } else if (event === 'pull_request_review' && action === 'submitted') {
      await handlePullRequestReview(ctx);
    } else if (event === 'issues' && (action === 'opened' || action === 'edited')) {
      await handleIssue(ctx);
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/coordinator', async (c) => {
  const body = await c.req.text();
  const signatureHeader = c.req.header('Upstash-Signature');
  const valid = await verifyQStashSignature(
    c.env.QSTASH_CURRENT_SIGNING_KEY,
    c.env.QSTASH_NEXT_SIGNING_KEY,
    body,
    signatureHeader ?? null,
  );
  if (!valid) return c.json({ error: 'Invalid QStash signature' }, 401);

  const github = new GitHubClient(c.env.BOT_PAT, '');
  const state = new StateManager(c.env.UPSTASH_REDIS_REST_URL, c.env.UPSTASH_REDIS_REST_TOKEN);
  try {
    await handleCoordinator({ github, state, env: c.env });
    return c.json({ ok: true });
  } catch (err) {
    console.error('Coordinator error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

app.post('/reminder', async (c) => {
  const body = await c.req.text();
  const signatureHeader = c.req.header('Upstash-Signature');
  const valid = await verifyQStashSignature(
    c.env.QSTASH_CURRENT_SIGNING_KEY,
    c.env.QSTASH_NEXT_SIGNING_KEY,
    body,
    signatureHeader ?? null,
  );
  if (!valid) return c.json({ error: 'Invalid QStash signature' }, 401);

  let p: { pr_number?: number; repo?: string };
  try { p = JSON.parse(body); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  if (!p.pr_number || !p.repo) return c.json({ error: 'Missing pr_number or repo' }, 400);

  const github = new GitHubClient(c.env.BOT_PAT, p.repo);
  try {
    await github.createComment(p.pr_number, '👋 Reminder: this PR is still open.');
    return c.json({ ok: true });
  } catch (err) {
    console.error('Reminder handler error:', err);
    return c.json({ error: 'Internal error' }, 500);
  }
});

export default app;
