import type { HandlerContext } from '../handlers/webhook.js';
import {
  setExclusiveAILabel,
  replaceAIReviewSection,
  buildAIReviewSectionComplete,
  buildAIReviewSectionUnresolved,
  buildAIReviewSectionSpendLimited,
  AI_CONTEXT,
} from '../handlers/webhook.js';
import { SpendGuard, calculateCost } from './spend-guard.js';
import { createProvider } from './ai-provider.js';
import { fetchReviewConfig, getContextFiles } from './review-config.js';
import { parseReviewHistory, addReviewRound } from './review-history.js';
import { gatherContextualFiles } from './context-gatherer.js';
import { buildRoundComment } from './review-comment.js';
import type { ReviewRound } from './types.js';

const MAX_DIFF_LINES = 600;

function truncateDiff(diff: string): string {
  const lines = diff.split('\n');
  if (lines.length <= MAX_DIFF_LINES) return diff;
  return lines.slice(0, MAX_DIFF_LINES).join('\n') + `\n\n… diff truncated at ${MAX_DIFF_LINES} lines (${lines.length - MAX_DIFF_LINES} lines omitted)`;
}

export async function executeReview(
  ctx: HandlerContext,
  prNumber: number,
  sha: string,
  hq: { id: number; body: string } | null,
  baseSha?: string,
): Promise<void> {
  const { github, env } = ctx;
  const repo = ctx.repo;

  const spendGuard = new SpendGuard(env);

  // 1. Check spend limits
  const limitCheck = await spendGuard.checkLimits(repo);
  if (!limitCheck.allowed) {
    await setExclusiveAILabel(github, prNumber, 'ai-review: not started');
    await github.setCommitStatus(sha, 'failure', AI_CONTEXT, 'AI review skipped — spend limit reached');

    if (hq) {
      const section = buildAIReviewSectionSpendLimited(limitCheck.reason ?? 'limit reached');
      await github.updateComment(hq.id, replaceAIReviewSection(hq.body, section));
    }
    await github.createComment(prNumber, `⛔ AI review skipped — spend limit reached: ${limitCheck.reason}`);
    return;
  }

  // 2. Fetch config and PR data in parallel
  const prData = await github.getPR(prNumber);
  const headRef = prData.head.sha;

  const [config, diff] = await Promise.all([
    fetchReviewConfig(github, headRef),
    baseSha
      ? github.getPRDiffSince(baseSha, sha)
      : github.getPRDiff(prNumber),
  ]);

  const truncatedDiff = truncateDiff(diff);

  // 3. Fetch context files
  const manualContextFiles = await getContextFiles(github, config, headRef);
  const autoContextFiles = await gatherContextualFiles(
    github,
    truncatedDiff,
    headRef,
    new Set(Object.keys(manualContextFiles)),
  );
  const contextFiles = { ...autoContextFiles, ...manualContextFiles };

  // 4. Get review history and determine round number — fetch comments once for both
  const prComments = await github.getIssueComments(prNumber);
  const hqFresh = hq ?? (() => {
    const c = prComments.find(c => c.user.login === 'rickcedwhat-ai' && c.body.includes('<!-- bot-hq -->'));
    return c ? { id: c.id, body: c.body } : null;
  })();
  const history = hqFresh ? parseReviewHistory(hqFresh.body) : [];
  let maxRound = 0;
  for (const c of prComments) {
    const m = c.body.match(/<!-- review-round:(\d+) -->/);
    if (m) maxRound = Math.max(maxRound, parseInt(m[1]));
  }
  const round = maxRound + 1;

  // 5. Call AI provider
  const provider = createProvider(env);
  const result = await provider.generateReview({
    prNumber,
    prTitle: prData.title,
    prBody: (prData as { body?: string }).body ?? '',
    diff: truncatedDiff,
    contextFiles,
    config,
    history,
    headSha: sha,
  });

  // 6. Post round comment
  const roundBody = buildRoundComment(round, result.structured);
  await github.createComment(prNumber, roundBody);

  // 7. Record spend
  const cost = calculateCost(result.input_tokens, result.output_tokens);
  await spendGuard.recordSpend(repo, cost);

  // 8. Build history round
  const firstIssueLine = result.structured.issues[0]
    ? `${result.structured.issues[0].title} (${result.structured.issues.length} issue${result.structured.issues.length === 1 ? '' : 's'})`
    : 'No issues found';

  const newRound: ReviewRound = {
    round,
    timestamp: new Date().toISOString(),
    commit_sha: sha,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    cost,
    summary: firstIssueLine,
  };
  const updatedHistory = addReviewRound(history, newRound);

  // 9. Update HQ and labels — HQ update is critical; label/status are best-effort
  const hasIssues = result.structured.issues.length > 0;
  const label = hasIssues ? 'ai-review: unresolved' : 'ai-review: complete';
  const statusState = hasIssues ? 'failure' : 'success';
  const statusDesc = hasIssues ? `AI review: ${result.structured.issues.length} issue(s)` : 'AI review passed';

  // Fire label + status updates without blocking HQ update
  setExclusiveAILabel(github, prNumber, label).catch(e => console.error(`[PR#${prNumber}] setExclusiveAILabel failed:`, e));
  github.setCommitStatus(sha, statusState, AI_CONTEXT, statusDesc).catch(e => console.error(`[PR#${prNumber}] setCommitStatus failed:`, e));

  // HQ update: use hqFresh (already fetched in step 4) — avoids a redundant getIssueComments
  // call that could race with the concurrent fire-and-forget label/status requests above.
  const spendStatus = await spendGuard.getSpendStatus(repo).catch(e => {
    console.error(`[PR#${prNumber}] getSpendStatus failed:`, e);
    return null;
  });

  if (hqFresh) {
    const section = hasIssues
      ? buildAIReviewSectionUnresolved(result.structured.issues.length, spendStatus, updatedHistory)
      : buildAIReviewSectionComplete(spendStatus, updatedHistory);
    await github.updateComment(hqFresh.id, replaceAIReviewSection(hqFresh.body, section)).catch(e => {
      console.error(`[PR#${prNumber}] updateComment (HQ) failed:`, e);
    });
  } else {
    console.error(`[PR#${prNumber}] HQ comment not found — skipping HQ update`);
  }
}
