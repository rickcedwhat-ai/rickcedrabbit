import type { GitHubClient } from './github.js';

const MAX_IMPORT_FILES = 8;
const MAX_CALLER_FILES = 5;
const MAX_FILE_LINES = 300;
const MAX_SYMBOLS = 4;

function truncate(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= MAX_FILE_LINES) return content;
  return lines.slice(0, MAX_FILE_LINES).join('\n') + `\n… (truncated at ${MAX_FILE_LINES} lines)`;
}

// Resolve a relative import path to a repo-root path, trying common extensions.
function resolveImportPath(fromFile: string, importPath: string): string[] {
  const dir = fromFile.includes('/') ? fromFile.split('/').slice(0, -1).join('/') : '';
  const parts = (dir ? dir + '/' + importPath : importPath).split('/');
  const normalized: string[] = [];
  for (const p of parts) {
    if (p === '..') normalized.pop();
    else if (p !== '.') normalized.push(p);
  }
  const base = normalized.join('/');
  // Try with and without extensions, and index files
  const candidates = [
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`,
  ];
  // If it already has an extension, try as-is first
  if (/\.\w+$/.test(base)) return [base, ...candidates];
  return candidates;
}

function extractRelativeImports(content: string, filePath: string): string[][] {
  const importRe = /import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const candidates: string[][] = [];
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    if (m[1].startsWith('.')) candidates.push(resolveImportPath(filePath, m[1]));
  }
  while ((m = requireRe.exec(content)) !== null) {
    if (m[1].startsWith('.')) candidates.push(resolveImportPath(filePath, m[1]));
  }
  return candidates;
}

// Extract exported symbols that appear on added/changed lines in the diff.
function extractChangedSymbols(diff: string): string[] {
  const symbols = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const s = line.slice(1).trim();
    const m =
      s.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ??
      s.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/) ??
      s.match(/^export\s+(?:const|let|type|interface)\s+(\w+)/);
    if (m) symbols.add(m[1]);
    if (symbols.size >= MAX_SYMBOLS) break;
  }
  return [...symbols];
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rb', '.java', '.cs', '.php', '.cpp', '.c', '.rs', '.swift', '.kt']);

function getExtension(path: string): string {
  const m = path.match(/(\.\w+)$/);
  return m ? m[1].toLowerCase() : '';
}

// Parse changed file paths out of a unified diff.
function parseDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+\s+b\/(.+)/);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

// Parse ALL touched paths (including deletions via --- a/path).
function parseAllDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    const add = line.match(/^\+\+\+\s+b\/(.+)/);
    if (add) { paths.add(add[1]); continue; }
    const del = line.match(/^---\s+a\/(.+)/);
    if (del) paths.add(del[1]);
  }
  return [...paths];
}

function diffHasCodeFiles(diff: string): boolean {
  return parseAllDiffPaths(diff).some(p => CODE_EXTENSIONS.has(getExtension(p)));
}

export async function gatherContextualFiles(
  github: GitHubClient,
  diff: string,
  ref: string,
  manualContextFiles: Set<string>,
): Promise<Record<string, string>> {
  if (!diffHasCodeFiles(diff)) return {};

  const result: Record<string, string> = {};
  const seen = new Set(manualContextFiles);

  const changedPaths = parseDiffPaths(diff);

  // 1. Fetch full content of changed files and parse their imports
  const changedContents = await Promise.all(
    changedPaths.map(async (p) => ({ path: p, content: await github.getFileContent(p, ref) })),
  );

  const importCandidates: string[][] = [];
  for (const { path, content } of changedContents) {
    if (!content) continue;
    if (!seen.has(path)) {
      seen.add(path);
      result[path] = truncate(content);
    }
    importCandidates.push(...extractRelativeImports(content, path));
  }

  // 2. Resolve and fetch imported files (first candidate that exists)
  const importPaths = importCandidates.slice(0, MAX_IMPORT_FILES * 3);
  const importResults = await Promise.all(
    importPaths.map(async (candidates) => {
      for (const candidate of candidates) {
        if (seen.has(candidate)) return null;
        const content = await github.getFileContent(candidate, ref).catch(() => null);
        if (content) return { path: candidate, content };
      }
      return null;
    }),
  );

  let importCount = 0;
  for (const r of importResults) {
    if (!r || seen.has(r.path) || importCount >= MAX_IMPORT_FILES) continue;
    seen.add(r.path);
    result[r.path] = truncate(r.content);
    importCount++;
  }

  // 3. Extract changed symbols and search for callers
  const symbols = extractChangedSymbols(diff);
  if (symbols.length > 0) {
    const callerResults = await Promise.allSettled(
      symbols.map(sym => github.searchCode(sym)),
    );

    const callerPaths: string[] = [];
    for (const r of callerResults) {
      if (r.status === 'fulfilled') callerPaths.push(...r.value);
    }

    const uniqueCallers = [...new Set(callerPaths)]
      .filter(p => !seen.has(p) && !changedPaths.includes(p))
      .slice(0, MAX_CALLER_FILES);

    const callerContents = await Promise.all(
      uniqueCallers.map(async (p) => ({ path: p, content: await github.getFileContent(p, ref).catch(() => null) })),
    );

    for (const { path, content } of callerContents) {
      if (content && !seen.has(path)) {
        seen.add(path);
        result[path] = truncate(content);
      }
    }
  }

  return result;
}
