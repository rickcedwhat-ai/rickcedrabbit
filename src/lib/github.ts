import type { CommitState } from './types.js';

const BASE_URL = 'https://api.github.com';

export class GitHubClient {
  private headers: Record<string, string>;
  private repo: string;

  constructor(token: string, repo: string) {
    this.repo = repo;
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cr-bot/0.1.0',
    };
  }

  private async fetch(path: string, options: RequestInit = {}, attempt = 0): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...(options.headers as Record<string, string> ?? {}),
      },
    });

    // Retry on 429 (secondary rate limit) — respect Retry-After, cap at 5s.
    // Cloudflare Workers have a 30s wall-clock limit; a longer delay risks killing
    // the invocation before the retry completes.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '2', 10);
      const delay = Math.min(retryAfter, 5) * 1000;
      console.warn(`GitHub rate limit on ${path} — retrying in ${delay}ms (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, delay));
      return this.fetch(path, options, attempt + 1);
    }

    return res;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, options);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status} for ${path}: ${text}`);
    }
    // Some endpoints return 204 No Content
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  async createComment(issueNumber: number, body: string): Promise<{ id: number }> {
    return this.request(`/repos/${this.repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    return this.request(`/repos/${this.repo}/issues/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async getIssueComments(issueNumber: number): Promise<Array<{
    id: number;
    user: { login: string };
    body: string;
    created_at: string;
    updated_at: string;
  }>> {
    const all: Array<{ id: number; user: { login: string }; body: string; created_at: string; updated_at: string }> = [];
    let page = 1;
    while (true) {
      const batch: typeof all = await this.request(
        `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    return this.request(`/repos/${this.repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const encoded = encodeURIComponent(label);
    return this.request(`/repos/${this.repo}/issues/${issueNumber}/labels/${encoded}`, {
      method: 'DELETE',
    });
  }

  async getLabels(issueNumber: number): Promise<string[]> {
    const labels = await this.request<Array<{ name: string }>>(
      `/repos/${this.repo}/issues/${issueNumber}/labels`
    );
    return labels.map(l => l.name);
  }

  async setCommitStatus(
    sha: string,
    state: CommitState,
    context: string,
    description: string,
  ): Promise<void> {
    return this.request(`/repos/${this.repo}/statuses/${sha}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, context, description }),
    });
  }

  async getPR(prNumber: number): Promise<{
    number: number;
    title: string;
    head: { sha: string };
    base: { ref: string };
    user: { login: string };
  }> {
    return this.request(`/repos/${this.repo}/pulls/${prNumber}`);
  }

  async updateIssue(issueNumber: number, body: string): Promise<void> {
    return this.request(`/repos/${this.repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async getIssue(issueNumber: number): Promise<{ number: number; body: string }> {
    return this.request(`/repos/${this.repo}/issues/${issueNumber}`);
  }

  async listOpenPRs(): Promise<Array<{ number: number; title: string; updated_at: string }>> {
    return this.request(`/repos/${this.repo}/pulls?state=open&per_page=100`);
  }

  async getPRLabels(prNumber: number): Promise<string[]> {
    return this.getLabels(prNumber);
  }

  async getPRDiff(prNumber: number): Promise<string> {
    const res = await this.fetch(`/repos/${this.repo}/pulls/${prNumber}`, {
      headers: { 'Accept': 'application/vnd.github.v3.diff' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status} for PR diff: ${text}`);
    }
    return res.text();
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const data = await this.request<{ content: string; encoding: string }>(
        `/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      if (data.encoding === 'base64') {
        return atob(data.content.replace(/\n/g, ''));
      }
      return data.content;
    } catch (err) {
      if (err instanceof Error && err.message.includes('404')) return null;
      throw err;
    }
  }

  async createPRReview(prNumber: number, body: string, event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' = 'COMMENT'): Promise<void> {
    return this.request(`/repos/${this.repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, event }),
    });
  }

  async getIssueBody(issueNumber: number): Promise<{ title: string; body: string }> {
    const data = await this.request<{ title: string; body: string }>(
      `/repos/${this.repo}/issues/${issueNumber}`,
    );
    return { title: data.title, body: data.body };
  }

  // Returns file paths in this repo that contain the given symbol.
  async countCommitsSince(baseSha: string, headSha: string): Promise<number> {
    try {
      const data = await this.request<{ ahead_by: number }>(
        `/repos/${this.repo}/compare/${baseSha}...${headSha}`,
      );
      return data.ahead_by;
    } catch {
      return 0;
    }
  }

  async getPRDiffSince(baseSha: string, headSha: string): Promise<string> {
    const res = await this.fetch(`/repos/${this.repo}/compare/${baseSha}...${headSha}`, {
      headers: { 'Accept': 'application/vnd.github.v3.diff' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status} for compare diff: ${text}`);
    }
    return res.text();
  }

  async searchCode(symbol: string): Promise<string[]> {
    try {
      const q = encodeURIComponent(`${symbol} repo:${this.repo}`);
      const data = await this.request<{ items: Array<{ path: string }> }>(
        `/search/code?q=${q}&per_page=5`,
      );
      return data.items.map(i => i.path);
    } catch {
      return [];
    }
  }
}
