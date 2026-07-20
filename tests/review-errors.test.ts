import { describe, it, expect } from 'vitest';
import { classifyReviewError } from '../src/lib/review-errors.js';
import { buildAIReviewSectionFailed, replaceAIReviewSection } from '../src/handlers/webhook.js';

describe('classifyReviewError', () => {
  it('classifies GitHub 503 flake', () => {
    const c = classifyReviewError(new Error('GitHub API error 503 for /repos/x/pulls/1: No server is currently available'));
    expect(c.kind).toBe('github');
    expect(c.summary).toBe('GitHub API temporarily unavailable (503)');
    expect(c.detail).toContain('503');
  });

  it('classifies GitHub 502/504 as flake', () => {
    expect(classifyReviewError(new Error('GitHub API error 502 for /x')).summary).toContain('502');
    expect(classifyReviewError(new Error('GitHub API error 504 for /x')).summary).toContain('504');
  });

  it('classifies non-flake GitHub errors', () => {
    const c = classifyReviewError(new Error('GitHub API error 403 for /repos/x: Resource not accessible'));
    expect(c.kind).toBe('github');
    expect(c.summary).toBe('GitHub API error (403)');
  });

  it('classifies Anthropic overload', () => {
    const c = classifyReviewError(new Error('Anthropic API error 529: overloaded'));
    expect(c.kind).toBe('anthropic');
    expect(c.summary).toBe('Anthropic API temporarily unavailable (529)');
  });

  it('classifies Anthropic non-overload errors', () => {
    const c = classifyReviewError(new Error('Anthropic API error 401: invalid x-api-key'));
    expect(c.kind).toBe('anthropic');
    expect(c.summary).toBe('Anthropic API error (401)');
  });

  it('classifies network errors', () => {
    const c = classifyReviewError(new Error('fetch failed: ConnectTimeout'));
    expect(c.kind).toBe('unknown');
    expect(c.summary).toBe('Network error during review');
  });

  it('classifies unknown errors', () => {
    const c = classifyReviewError(new Error('boom'));
    expect(c.kind).toBe('unknown');
    expect(c.summary).toBe('Unexpected review failure');
    expect(c.detail).toBe('boom');
  });

  it('handles non-Error throws', () => {
    const c = classifyReviewError('string failure');
    expect(c.detail).toBe('string failure');
  });

  it('truncates long detail', () => {
    const c = classifyReviewError(new Error('x'.repeat(1000)));
    expect(c.detail.length).toBe(500);
  });
});

describe('buildAIReviewSectionFailed', () => {
  it('includes reason and retry hint', () => {
    const section = buildAIReviewSectionFailed('GitHub API temporarily unavailable (503)');
    expect(section).toContain('⚠️ AI review failed — GitHub API temporarily unavailable (503)');
    expect(section).toContain('@rickcedwhat-ai review');
    expect(section).toContain('- [ ] 🔍 Request AI review');
  });

  it('preserves history when provided', () => {
    const history = [{
      round: 1,
      timestamp: '2026-07-20T00:00:00.000Z',
      commit_sha: 'abc1234',
      input_tokens: 10,
      output_tokens: 20,
      cost: 0.001,
      summary: 'No issues found',
    }];
    const section = buildAIReviewSectionFailed('boom', history);
    expect(section).toContain('ai-review-history');
    expect(section).toContain('No issues found');
  });

  it('replaces an in-progress HQ section', () => {
    const hq = `<!-- bot-hq -->
<!-- ai-review-section-start -->
<!-- ai-review-trigger-time: 2026-07-20T00:22:23.022Z -->

### 🔍 AI Review
- [ ] 🔍 Request AI review

> ⏳ Review requested for #374 — AI review in progress…
<!-- ai-review-section-end -->
`;
    const updated = replaceAIReviewSection(hq, buildAIReviewSectionFailed('GitHub API temporarily unavailable (503)'));
    expect(updated).toContain('AI review failed');
    expect(updated).not.toContain('in progress');
  });
});
