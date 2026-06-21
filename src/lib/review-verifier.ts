import type { HandlerContext } from '../handlers/webhook.js';
import { setExclusiveAILabel, AI_CONTEXT, findHQComment, replaceAIReviewSection, buildAIReviewSectionComplete } from '../handlers/webhook.js';
import {
  findLatestRoundComment,
  parseIssueStates,
  parseIssueBody,
  parseLLMReply,
  updateIssueState,
  allIssuesResolved,
} from './review-comment.js';
import { SpendGuard } from './spend-guard.js';
import { parseReviewHistory } from './review-history.js';

async function verifySkips(
  apiKey: string,
  model: string,
  skips: Array<{ n: number; title: string; body: string; reason: string }>,
): Promise<Array<{ n: number; accepted: boolean; challenge?: string }>> {
  if (skips.length === 0) return [];

  const prompt = `You are validating skip justifications for code review findings.

For each finding + skip reason, respond ACCEPT if reasonable, or CHALLENGE - [brief reason] if not.
Reply exactly as: [N] ACCEPT  or  [N] CHALLENGE - reason

${skips.map(s => `FINDING ${s.n}: ${s.title}\n${s.body}\nSkip reason: "${s.reason}"`).join('\n\n')}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) return skips.map(s => ({ n: s.n, accepted: true })); // fail open

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

  const results: Array<{ n: number; accepted: boolean; challenge?: string }> = [];
  const re = /\[(\d+)\]\s+(ACCEPT|CHALLENGE)(?:\s*[-–:]\s*(.+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({
      n: parseInt(m[1]),
      accepted: m[2].toUpperCase() === 'ACCEPT',
      challenge: m[3]?.trim(),
    });
  }

  // Fall back to accepted for any skips not mentioned in the response
  for (const s of skips) {
    if (!results.find(r => r.n === s.n)) results.push({ n: s.n, accepted: true });
  }
  return results;
}

async function finalizeIfResolved(
  ctx: HandlerContext,
  prNumber: number,
  roundCommentBody: string,
  headSha: string,
): Promise<boolean> {
  const states = parseIssueStates(roundCommentBody);
  if (!allIssuesResolved(states)) return false;

  await setExclusiveAILabel(ctx.github, prNumber, 'ai-review: complete');
  await ctx.github.setCommitStatus(headSha, 'success', AI_CONTEXT, 'AI review complete');

  const hq = await findHQComment(ctx.github, prNumber);
  if (hq) {
    const history = parseReviewHistory(hq.body);
    const spendGuard = new SpendGuard(ctx.env);
    const spend = await spendGuard.getSpendStatus(ctx.repo);
    await ctx.github.updateComment(hq.id, replaceAIReviewSection(hq.body, buildAIReviewSectionComplete(spend, history)));
  }
  return true;
}

export async function handleLLMReply(
  ctx: HandlerContext,
  prNumber: number,
  replyBody: string,
  headSha: string,
): Promise<void> {
  const { github, env } = ctx;

  const roundComment = await findLatestRoundComment(github, prNumber);
  if (!roundComment) return;

  const replyItems = parseLLMReply(replyBody);
  if (replyItems.length === 0) return;

  const states = parseIssueStates(roundComment.body);
  // Allow replies to both open and challenged issues (challenged = skip was rejected, user may retry)
  const openNumbers = new Set(states.filter(s => s.state === 'open' || s.state === 'challenged').map(s => s.n));

  // Only process items that correspond to open/challenged issues
  const relevant = replyItems.filter(item => openNumbers.has(item.n));
  if (relevant.length === 0) return;

  // Separate fixes from skips
  const fixes = relevant.filter(r => r.action === 'fix');
  const skips = relevant.filter(r => r.action === 'skip');

  // Verify skips
  const skipDetails = skips.map(s => {
    const body = parseIssueBody(roundComment.body, s.n) ?? '';
    const titleMatch = roundComment.body.match(new RegExp(`\\[${s.n}\\]\\s+([^—]+)\\s*—`));
    return { n: s.n, title: titleMatch?.[1]?.trim() ?? `Issue ${s.n}`, body, reason: s.reason ?? '' };
  });

  const model = env.REVIEW_MODEL_OVERRIDE ?? 'claude-sonnet-4-6';
  const verifyResults = await verifySkips(env.ANTHROPIC_API_KEY, model, skipDetails);

  // Apply all state updates
  let updatedBody = roundComment.body;

  for (const fix of fixes) {
    updatedBody = updateIssueState(updatedBody, fix.n, 'fixed');
  }

  const challenges: Array<{ n: number; reason: string }> = [];
  for (const skip of skips) {
    const result = verifyResults.find(r => r.n === skip.n);
    if (result?.accepted === false) {
      updatedBody = updateIssueState(updatedBody, skip.n, 'challenged', result.challenge);
      challenges.push({ n: skip.n, reason: result.challenge ?? 'not accepted' });
    } else {
      updatedBody = updateIssueState(updatedBody, skip.n, 'skipped', skip.reason);
    }
  }

  await github.updateComment(roundComment.id, updatedBody);

  // Reply with challenge details if any
  if (challenges.length > 0) {
    const challengeText = challenges
      .map(c => `**[${c.n}]** ${c.reason}`)
      .join('\n');
    await github.createComment(prNumber, `Challenged ${challenges.length} skip(s):\n\n${challengeText}`);
  } else {
    // Check if everything is now resolved
    await finalizeIfResolved(ctx, prNumber, updatedBody, headSha);
  }
}

export async function handleOverride(
  ctx: HandlerContext,
  prNumber: number,
  arg: string,
  headSha: string,
): Promise<void> {
  const { github } = ctx;

  const roundComment = await findLatestRoundComment(github, prNumber);
  if (!roundComment) return;

  const states = parseIssueStates(roundComment.body);
  const openStates = states.filter(s => s.state === 'open' || s.state === 'challenged');

  let toOverride: number[];
  if (arg.trim().toLowerCase() === 'all') {
    toOverride = openStates.map(s => s.n);
  } else {
    const requested = arg.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    toOverride = requested.filter(n => openStates.some(s => s.n === n));
  }

  if (toOverride.length === 0) return;

  let updatedBody = roundComment.body;
  for (const n of toOverride) {
    updatedBody = updateIssueState(updatedBody, n, 'overridden');
  }
  await github.updateComment(roundComment.id, updatedBody);

  await finalizeIfResolved(ctx, prNumber, updatedBody, headSha);
}
