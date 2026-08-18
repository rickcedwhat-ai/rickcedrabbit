import { describe, it, expect } from 'vitest';
import {
  HQ_COMMENT_TEMPLATE,
  getHQAction,
  buildAIReviewSectionSkipped,
  buildAIReviewSectionFailed,
  replaceAIReviewSection,
  ensureSkipCheckbox,
} from '../src/handlers/webhook.js';

describe('getHQAction', () => {
  it('detects skip checkbox', () => {
    expect(getHQAction('- [x] ⏭️ Skip AI review')).toEqual({ type: 'skip' });
  });

  it('detects skip by label if the emoji is stripped', () => {
    expect(getHQAction('- [x] Skip AI review')).toEqual({ type: 'skip' });
  });

  it('prefers skip when both skip and review are checked', () => {
    const body = `- [x] 🔍 Request AI review\n- [x] ⏭️ Skip AI review`;
    expect(getHQAction(body)).toEqual({ type: 'skip' });
  });

  it('detects full review request', () => {
    expect(getHQAction('- [x] 🔍 Request AI review')).toEqual({ type: 'full' });
  });

  it('detects partial review with base sha', () => {
    const body = `- [x] 🔄 Partial review (2 new commits)\n<!-- partial-base-sha: abcdef1 -->`;
    expect(getHQAction(body)).toEqual({ type: 'partial', baseSha: 'abcdef1' });
  });

  it('returns null when nothing is checked', () => {
    expect(getHQAction(HQ_COMMENT_TEMPLATE)).toBeNull();
  });
});

describe('buildAIReviewSectionSkipped', () => {
  it('includes skip marker, both checkboxes, and merge hint', () => {
    const section = buildAIReviewSectionSkipped();
    expect(section).toContain('<!-- ai-review-skipped -->');
    expect(section).toContain('- [ ] 🔍 Request AI review');
    expect(section).toContain('- [ ] ⏭️ Skip AI review');
    expect(section).toContain('AI review skipped — merge is unblocked');
  });

  it('preserves history when provided', () => {
    const section = buildAIReviewSectionSkipped([{
      round: 1,
      timestamp: '2026-07-20T00:00:00.000Z',
      commit_sha: 'abc1234',
      input_tokens: 10,
      output_tokens: 20,
      cost: 0.001,
      summary: 'No issues found',
    }]);
    expect(section).toContain('ai-review-history');
    expect(section).toContain('No issues found');
  });

  it('replaces an in-progress HQ section', () => {
    const hq = `<!-- bot-hq -->
<!-- ai-review-section-start -->
### 🔍 AI Review
- [x] ⏭️ Skip AI review
> ⏳ Review requested for #374 — AI review in progress…
<!-- ai-review-section-end -->
`;
    const updated = replaceAIReviewSection(hq, buildAIReviewSectionSkipped());
    expect(updated).toContain('AI review skipped');
    expect(updated).not.toContain('in progress');
    expect(updated).toContain('- [ ] ⏭️ Skip AI review');
  });
});

describe('HQ template', () => {
  it('ships both request and skip checkboxes', () => {
    expect(HQ_COMMENT_TEMPLATE).toContain('- [ ] 🔍 Request AI review');
    expect(HQ_COMMENT_TEMPLATE).toContain('- [ ] ⏭️ Skip AI review');
  });

  it('backfills skip onto older HQ comments', () => {
    const old = `### 🔍 AI Review\n- [ ] 🔍 Request AI review\n\n> _Not yet requested_\n`;
    const updated = ensureSkipCheckbox(old);
    expect(updated).toContain('- [ ] ⏭️ Skip AI review');
    expect(ensureSkipCheckbox(updated)).toBe(updated);
  });

  it('includes skip checkbox on failure sections too', () => {
    expect(buildAIReviewSectionFailed('boom')).toContain('- [ ] ⏭️ Skip AI review');
  });
});
