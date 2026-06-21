import type { AIProviderResponse, ReviewConfig, ReviewRound, ReviewResponse, StructuredReview } from './types.js';
import type { Env } from '../index.js';

export interface ReviewContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;
  contextFiles: Record<string, string>;
  config: ReviewConfig;
  history: ReviewRound[];
  headSha: string;
}

export interface PlanContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  contextFiles: Record<string, string>;
  config: ReviewConfig;
}

export interface AIProvider {
  generateReview(ctx: ReviewContext): Promise<ReviewResponse>;
  generatePlan(ctx: PlanContext): Promise<AIProviderResponse>;
}

const REVIEW_TOOL = {
  name: 'submit_review',
  description: 'Submit the structured code review results',
  input_schema: {
    type: 'object',
    required: ['summary', 'issues'],
    properties: {
      summary: { type: 'string', description: '1-2 sentence summary of the PR and findings count' },
      issues: {
        type: 'array',
        description: 'Actionable issues found. Empty array if the PR looks good.',
        items: {
          type: 'object',
          required: ['number', 'title', 'file', 'body'],
          properties: {
            number: { type: 'integer' },
            title: { type: 'string', description: 'Short title under 60 chars' },
            file: { type: 'string' },
            line: { type: ['integer', 'null'] },
            body: { type: 'string', description: '2-4 sentence explanation' },
          },
        },
      },
    },
  },
};

function buildReviewPrompt(ctx: ReviewContext): string {
  const { prNumber, prTitle, prBody, diff, contextFiles, config, history } = ctx;

  const focusSection = config.focus?.length
    ? `\n**Focus areas:**\n${config.focus.map(f => `- ${f}`).join('\n')}`
    : '';
  const ignoreSection = config.ignore?.length
    ? `\n**Ignore patterns:**\n${config.ignore.map(i => `- ${i}`).join('\n')}`
    : '';
  const checklistSection = config.checklist?.length
    ? `\n**Checklist items to verify:**\n${config.checklist.map(c => `- [ ] ${c}`).join('\n')}`
    : '';

  const contextFilesSection = Object.keys(contextFiles).length
    ? '\n\n## Context Files\n' + Object.entries(contextFiles)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n')
    : '';

  const historySection = history.length
    ? '\n\n## Prior Review Rounds\n' + history
        .map(r => `**Round ${r.round}** (${r.timestamp.slice(0, 10)}, commit \`${r.commit_sha.slice(0, 7)}\`): ${r.summary}`)
        .join('\n')
    : '';

  return `You are a senior software engineer performing a code review on a pull request.

## Pull Request #${prNumber}: ${prTitle}

${prBody ? `### Description\n${prBody}\n` : ''}${focusSection}${ignoreSection}${checklistSection}${contextFilesSection}${historySection}

## Diff
\`\`\`diff
${diff}
\`\`\`

## Instructions
Review the diff. Find bugs, security issues, logic errors, and significant code quality problems. Skip minor style nits.

For each issue: assign a sequential number starting at 1, write a short title (under 60 chars), the file path, line number if applicable, and a 2-4 sentence explanation of the problem and how to fix it.

Call submit_review with your findings. If the PR looks good, pass an empty issues array.`;
}

function buildPlanPrompt(ctx: PlanContext): string {
  const { issueNumber, issueTitle, issueBody, contextFiles, config } = ctx;

  const focusSection = config.planning?.focus?.length
    ? `\n**Planning focus:**\n${config.planning.focus.map(f => `- ${f}`).join('\n')}`
    : '';

  const contextFilesSection = Object.keys(contextFiles).length
    ? '\n\n## Context Files\n' + Object.entries(contextFiles)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n')
    : '';

  return `You are a senior software engineer tasked with creating an implementation plan for a GitHub issue.

## Issue #${issueNumber}: ${issueTitle}

### Description
${issueBody}
${focusSection}${contextFilesSection}

## Instructions
Create a detailed, actionable implementation plan. Break it down into phases/tasks with clear acceptance criteria. Include:
- What files need to be created or modified
- Key design decisions and rationale
- Potential risks or gotchas
- Testing considerations

Format as GitHub-flavored markdown with clear headers and checkboxes for tasks.`;
}

export class ClaudeProvider implements AIProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, modelOverride?: string) {
    this.apiKey = apiKey;
    this.model = modelOverride ?? 'claude-haiku-4-5';
  }

  async generateReview(ctx: ReviewContext): Promise<ReviewResponse> {
    const model = ctx.config.model_override ?? this.model;
    return this.callReviewAPI(buildReviewPrompt(ctx), model);
  }

  async generatePlan(ctx: PlanContext): Promise<AIProviderResponse> {
    return this.callAPI(buildPlanPrompt(ctx), this.model);
  }

  private async callReviewAPI(prompt: string, model: string): Promise<ReviewResponse> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        tools: [REVIEW_TOOL],
        tool_choice: { type: 'tool', name: 'submit_review' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    const toolUse = data.content.find(b => b.type === 'tool_use');
    if (!toolUse?.input) throw new Error('No tool_use block in review response');

    return {
      structured: toolUse.input as StructuredReview,
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      model: data.model,
    };
  }

  private async callAPI(prompt: string, model: string): Promise<AIProviderResponse> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    return {
      review_body: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      model: data.model,
    };
  }
}

export class OpenAIProvider implements AIProvider {
  async generateReview(_ctx: ReviewContext): Promise<ReviewResponse> {
    throw new Error('OpenAIProvider: not implemented');
  }
  async generatePlan(_ctx: PlanContext): Promise<AIProviderResponse> {
    throw new Error('OpenAIProvider: not implemented');
  }
}

export class GeminiProvider implements AIProvider {
  async generateReview(_ctx: ReviewContext): Promise<ReviewResponse> {
    throw new Error('GeminiProvider: not implemented');
  }
  async generatePlan(_ctx: PlanContext): Promise<AIProviderResponse> {
    throw new Error('GeminiProvider: not implemented');
  }
}

export function createProvider(env: Env): AIProvider {
  const provider = (env.REVIEW_PROVIDER ?? 'claude').toLowerCase();
  if (provider === 'openai') return new OpenAIProvider();
  if (provider === 'gemini') return new GeminiProvider();
  return new ClaudeProvider(env.ANTHROPIC_API_KEY, env.REVIEW_MODEL_OVERRIDE);
}
