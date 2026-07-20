export type ReviewFailureKind = 'github' | 'anthropic' | 'unknown';

export interface ClassifiedReviewError {
  kind: ReviewFailureKind;
  /** Short line for HQ + commit status (status desc is capped at 140 chars). */
  summary: string;
  /** Longer detail for the PR failure comment. */
  detail: string;
}

/**
 * Classify a review-pipeline error so HQ / status / comments can show a useful reason
 * instead of leaving the PR stuck at "AI review in progress".
 */
export function classifyReviewError(err: unknown): ClassifiedReviewError {
  const message = err instanceof Error ? err.message : String(err);
  const detail = message.slice(0, 500);

  const githubMatch = message.match(/GitHub API error (\d+)/i);
  if (githubMatch) {
    const status = githubMatch[1];
    const flake = status === '502' || status === '503' || status === '504';
    return {
      kind: 'github',
      summary: flake
        ? `GitHub API temporarily unavailable (${status})`
        : `GitHub API error (${status})`,
      detail,
    };
  }

  const anthropicMatch = message.match(/Anthropic API error (\d+)/i);
  if (anthropicMatch) {
    const status = anthropicMatch[1];
    const overloaded = status === '529' || status === '503';
    return {
      kind: 'anthropic',
      summary: overloaded
        ? `Anthropic API temporarily unavailable (${status})`
        : `Anthropic API error (${status})`,
      detail,
    };
  }

  if (/failed to fetch|network|ECONNRESET|ETIMEDOUT|ConnectTimeout|ConnectError/i.test(message)) {
    return {
      kind: 'unknown',
      summary: 'Network error during review',
      detail,
    };
  }

  return {
    kind: 'unknown',
    summary: 'Unexpected review failure',
    detail,
  };
}
