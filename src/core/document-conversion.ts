import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { safeDump as yamlSafeDump, safeLoad as yamlSafeLoad } from 'js-yaml';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

export const SUPPORTED_DOCUMENT_EXTS = [
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
] as const;

export const DEFAULT_DOCUMENT_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const DOCLING_METADATA_KEY = 'gbrain_docling';

export interface DoclingRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type DoclingRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<DoclingRunResult>;

export interface DocumentConversionResult {
  markdown: string;
  sidecarPath: string;
  reused: boolean;
}

export interface ConvertDocumentOptions {
  maxSourceBytes?: number;
  runner?: DoclingRunner;
  now?: () => Date;
}

export type DocumentConverter = (
  sourcePath: string,
  relativePath: string,
  opts?: ConvertDocumentOptions,
) => Promise<DocumentConversionResult>;

interface DoclingMetadata {
  converter: 'docling';
  generated_at: string;
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  body_sha256: string;
}

export function isConvertibleDocumentPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (isDoclingSidecarPath(lower)) return false;
  return SUPPORTED_DOCUMENT_EXTS.some((ext) => lower.endsWith(ext));
}

export function isDoclingSidecarPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SUPPORTED_DOCUMENT_EXTS.some((ext) => lower.endsWith(`${ext}.md`));
}

export function resolveDocumentMaxSourceBytes(): number {
  const raw = process.env.GBRAIN_DOCLING_MAX_SOURCE_BYTES;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_DOCUMENT_SOURCE_MAX_BYTES;
}

export async function convertDocumentToMarkdown(
  sourcePath: string,
  relativePath: string,
  opts: ConvertDocumentOptions = {},
): Promise<DocumentConversionResult> {
  const stat = statSync(sourcePath);
  const maxSourceBytes = opts.maxSourceBytes ?? resolveDocumentMaxSourceBytes();
  if (stat.size > maxSourceBytes) {
    throw new Error(`Document too large (${stat.size} bytes, max ${maxSourceBytes})`);
  }

  const sourceHash = sha256File(sourcePath);
  const sidecarPath = `${sourcePath}.md`;
  const cached = readValidSidecar(sidecarPath, sourceHash);
  if (cached) {
    return { markdown: cached.markdown, sidecarPath, reused: true };
  }

  const outputDir = mkdtempSync(join(tmpdir(), 'gbrain-docling-out-'));
  try {
    await runDocling(sourcePath, outputDir, opts.runner ?? defaultDoclingRunner);
    const markdownPath = findMarkdownOutput(outputDir);
    if (!markdownPath) {
      throw new Error('Docling did not produce a Markdown file');
    }

    const body = normalizeMarkdownBody(readFileSync(markdownPath, 'utf8'));
    const metadata: DoclingMetadata = {
      converter: 'docling',
      generated_at: (opts.now ?? (() => new Date()))().toISOString(),
      source_path: relativePath.replace(/\\/g, '/'),
      source_sha256: sourceHash,
      source_bytes: stat.size,
      body_sha256: sha256String(body),
    };
    const title = documentTitle(sourcePath);
    const sidecarMarkdown = buildSidecarMarkdown(title, metadata, body);
    atomicWriteFile(sidecarPath, sidecarMarkdown);
    return { markdown: sidecarMarkdown, sidecarPath, reused: false };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

async function runDocling(sourcePath: string, outputDir: string, runner: DoclingRunner): Promise<void> {
  const args = [sourcePath, '--to', 'md', '--output', outputDir];
  const direct = await runner('docling', args, { timeoutMs: 10 * 60 * 1000 });
  if (isCommandMissing(direct)) {
    const uvx = await runner('uvx', ['--from', 'docling', 'docling', ...args], {
      timeoutMs: 10 * 60 * 1000,
    });
    if (isCommandMissing(uvx)) {
      throw new Error('Docling is not available. Install docling or uv, or run `uvx --from docling docling --help` once to verify the runtime.');
    }
    assertDoclingSuccess('uvx --from docling docling', uvx);
    return;
  }
  assertDoclingSuccess('docling', direct);
}

function assertDoclingSuccess(command: string, result: DoclingRunResult): void {
  if (result.exitCode === 0) return;
  const stderr = (result.stderr || result.stdout || '').trim();
  throw new Error(`Docling conversion failed via ${command} (exit ${result.exitCode}): ${truncate(stderr || 'no output')}`);
}

function isCommandMissing(result: DoclingRunResult): boolean {
  return result.errorCode === 'ENOENT' || result.exitCode === 127;
}

async function defaultDoclingRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
): Promise<DoclingRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${opts.timeoutMs}ms`.trim() });
      }, opts.timeoutMs)
      : null;
    timeout?.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: err.message, errorCode: err.code });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function readValidSidecar(sidecarPath: string, sourceHash: string): { markdown: string } | null {
  if (!existsSync(sidecarPath)) return null;
  let markdown: string;
  try {
    markdown = readFileSync(sidecarPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = splitFrontmatter(markdown);
  if (!parsed) return null;
  const metadata = parsed.frontmatter[DOCLING_METADATA_KEY] as Partial<DoclingMetadata> | undefined;
  if (!metadata || metadata.converter !== 'docling') return null;
  if (metadata.source_sha256 !== sourceHash) return null;
  if (metadata.body_sha256 !== sha256String(normalizeMarkdownBody(parsed.body))) return null;
  return { markdown };
}

function splitFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0) return null;
  const yaml = normalized.slice(4, close);
  const body = normalized.slice(close + '\n---\n'.length);
  let frontmatter: unknown;
  try {
    frontmatter = yamlSafeLoad(yaml) ?? {};
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) return null;
  return { frontmatter: frontmatter as Record<string, unknown>, body };
}

function buildSidecarMarkdown(title: string, metadata: DoclingMetadata, body: string): string {
  const yaml = yamlSafeDump({
    type: 'document',
    title,
    [DOCLING_METADATA_KEY]: metadata,
  }, { lineWidth: -1, sortKeys: false }).trimEnd();
  return `---\n${yaml}\n---\n\n${body}`;
}

function findMarkdownOutput(dir: string): string | null {
  const found: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(full);
      }
    }
  }
  walk(dir);
  found.sort();
  return found[0] ?? null;
}

function normalizeMarkdownBody(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  return normalized ? `${normalized}\n` : '';
}

function documentTitle(sourcePath: string): string {
  return basename(sourcePath).replace(/\.[^.]+$/, '');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256String(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function atomicWriteFile(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function truncate(value: string): string {
  return value.length <= 2000 ? value : `${value.slice(0, 2000)}...`;
}
