import type { GitHubClient } from './github.js';
import type { IssueState, IssueStateRecord, ReviewIssue, StructuredReview } from './types.js';

function stateEmoji(state: IssueState): string {
  switch (state) {
    case 'fixed': return '✅ ';
    case 'skipped': return '↩️ ';
    case 'challenged': return '❌ ';
    case 'overridden': return '⚙️ ';
    default: return '';
  }
}

function buildIssueBlock(issue: ReviewIssue): string {
  const loc = issue.line != null ? `:${issue.line}` : '';
  return `<!-- issue-${issue.number}-open -->
<details><summary>[${issue.number}] ${issue.title} — ${issue.file}${loc}</summary>

${issue.body}

</details>`;
}

export function buildRoundComment(round: number, structured: StructuredReview): string {
  const header = round === 1 ? '## AI Review' : `## AI Review — Round ${round}`;

  const noIssues = structured.issues.length === 0
    ? '\n> ✅ No actionable issues found.\n'
    : '';

  const tldr = structured.issues.length > 0
    ? (() => {
        const count = structured.issues.length;
        const label = count === 1 ? '1 issue' : `${count} issues`;
        const lines = structured.issues
          .map(i => {
            const loc = i.line != null ? `:${i.line}` : '';
            return `[${i.number}] ${i.title} — ${i.file}${loc}\n${i.body}`;
          })
          .join('\n\n');
        const inner = '```\nReview findings — reply with [N] fix or [N] skip + reason:\n\n' + lines + '\n```';
        return `<details>\n<summary>📋 ${label} — expand to copy prompt</summary>\n\n${inner}\n\n</details>`;
      })()
    : '';

  const details = structured.issues.map(buildIssueBlock).join('\n\n');

  const parts = [header, structured.summary + noIssues];
  if (tldr) parts.push(tldr);
  if (details) parts.push(details);

  return `<!-- review-round:${round} -->\n` + parts.join('\n\n');
}

// Update a single issue's state in-place in the round comment body.
export function updateIssueState(body: string, n: number, state: IssueState, reason?: string): string {
  // Update the HTML marker
  body = body.replace(
    new RegExp(`<!-- issue-${n}-\\w+ -->`),
    `<!-- issue-${n}-${state} -->`,
  );

  // Update the <details> summary line: strip any existing emoji prefix, then re-add
  body = body.replace(
    new RegExp(`(<details><summary>)(?:[^\\[]*?)\\[${n}\\]([^\\n]+?)(</summary>)`),
    (_, open, content, close) => {
      // content = " title — file:line[ — old reason]"
      const parts = content.split(' — ');
      const base = parts.slice(0, 2).join(' — '); // "title — file:line"
      const suffix = (state === 'challenged' || state === 'skipped') && reason
        ? ` — ${reason}`
        : '';
      return `${open}${stateEmoji(state)}[${n}]${base}${suffix}${close}`;
    },
  );

  return body;
}

export function parseIssueStates(body: string): IssueStateRecord[] {
  const states: IssueStateRecord[] = [];
  const re = /<!-- issue-(\d+)-(\w+) -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    states.push({ n: parseInt(m[1]), state: m[2] as IssueState });
  }
  return states;
}

export function parseIssueBody(body: string, n: number): string | null {
  const re = new RegExp(
    `<!-- issue-${n}-\\w+ -->\\n<details><summary>[^<]+</summary>\\n\\n([\\s\\S]+?)\\n\\n</details>`,
  );
  const m = re.exec(body);
  return m ? m[1] : null;
}

export function parseLLMReply(body: string): Array<{ n: number; action: 'fix' | 'skip'; reason?: string }> {
  const items: Array<{ n: number; action: 'fix' | 'skip'; reason?: string }> = [];
  const re = /\[(\d+)\]\s+(fix|skip)(?:\s*[-–—:]\s*(.+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    items.push({
      n: parseInt(m[1]),
      action: m[2].toLowerCase() as 'fix' | 'skip',
      reason: m[3]?.trim(),
    });
  }
  return items;
}

export async function findLatestRoundComment(
  github: GitHubClient,
  prNumber: number,
): Promise<{ id: number; body: string; round: number } | null> {
  const comments = await github.getIssueComments(prNumber);
  let latest: { id: number; body: string; round: number } | null = null;
  for (const c of comments) {
    const m = c.body.match(/<!-- review-round:(\d+) -->/);
    if (m) {
      const round = parseInt(m[1]);
      if (!latest || round > latest.round) {
        latest = { id: c.id, body: c.body, round };
      }
    }
  }
  return latest;
}

export async function countRoundComments(github: GitHubClient, prNumber: number): Promise<number> {
  const latest = await findLatestRoundComment(github, prNumber);
  return latest?.round ?? 0;
}

export function allIssuesResolved(states: IssueStateRecord[]): boolean {
  return states.length > 0 && states.every(s =>
    s.state === 'fixed' || s.state === 'skipped' || s.state === 'overridden',
  );
}
