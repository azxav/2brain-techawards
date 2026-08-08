import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  convertDocumentToMarkdown,
  isConvertibleDocumentPath,
  isDoclingSidecarPath,
} from '../src/core/document-conversion.ts';

const TMP_PREFIX = join(tmpdir(), 'gbrain-docling-');

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(TMP_PREFIX);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runnerWriting(markdownByCall: string[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = async (command: string, args: string[]) => {
    calls.push({ command, args });
    const outputIdx = args.indexOf('--output');
    expect(outputIdx).toBeGreaterThanOrEqual(0);
    const outputDir = args[outputIdx + 1];
    expect(outputDir).toBeTruthy();
    writeFileSync(join(outputDir!, `converted-${calls.length}.md`), markdownByCall[calls.length - 1] ?? '# Empty');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

describe('document conversion classification', () => {
  test('recognizes PDF, Word, Excel, slides, and legacy Office originals', () => {
    for (const path of [
      'docs/brief.pdf',
      'docs/brief.docx',
      'docs/brief.doc',
      'docs/model.xlsx',
      'docs/model.xls',
      'docs/deck.pptx',
      'docs/deck.ppt',
    ]) {
      expect(isConvertibleDocumentPath(path)).toBe(true);
    }
    expect(isConvertibleDocumentPath('docs/brief.md')).toBe(false);
    expect(isConvertibleDocumentPath('docs/brief.pdf.md')).toBe(false);
  });

  test('recognizes generated Docling sidecars for supported document originals', () => {
    expect(isDoclingSidecarPath('docs/brief.pdf.md')).toBe(true);
    expect(isDoclingSidecarPath('docs/model.xlsx.md')).toBe(true);
    expect(isDoclingSidecarPath('docs/deck.ppt.md')).toBe(true);
    expect(isDoclingSidecarPath('docs/manual.md')).toBe(false);
    expect(isDoclingSidecarPath('docs/archive.zip.md')).toBe(false);
  });
});

describe('convertDocumentToMarkdown', () => {
  test('converts with Docling and writes a same-directory name.ext.md sidecar', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'Brief.pdf');
      writeFileSync(source, 'source-v1');
      const { calls, runner } = runnerWriting(['# Converted\n\nBody v1\n']);

      const result = await convertDocumentToMarkdown(source, 'docs/Brief.pdf', {
        runner,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });

      expect(result.reused).toBe(false);
      expect(result.sidecarPath).toBe(join(dir, 'Brief.pdf.md'));
      expect(result.markdown).toContain('# Converted');
      expect(calls.length).toBe(1);
      expect(calls[0].args).toContain('--to');
      expect(calls[0].args).toContain('md');

      const sidecar = readFileSync(join(dir, 'Brief.pdf.md'), 'utf8');
      expect(sidecar).toContain('gbrain_docling:');
      expect(sidecar).toContain('source_path: docs/Brief.pdf');
      expect(sidecar).toContain('2026-01-02T03:04:05.000Z');
      expect(sidecar).toContain('# Converted');
    });
  });

  test('reuses an unchanged valid sidecar without invoking Docling again', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'Brief.pdf');
      writeFileSync(source, 'source-v1');
      const { runner } = runnerWriting(['# Converted\n\nBody v1\n']);

      await convertDocumentToMarkdown(source, 'docs/Brief.pdf', { runner });
      const reused = await convertDocumentToMarkdown(source, 'docs/Brief.pdf', {
        runner: async () => {
          throw new Error('runner should not be called for valid sidecar');
        },
      });

      expect(reused.reused).toBe(true);
      expect(reused.markdown).toContain('Body v1');
    });
  });

  test('regenerates when the source document hash changes', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'Brief.pdf');
      writeFileSync(source, 'source-v1');
      const { calls, runner } = runnerWriting([
        '# Converted\n\nBody v1\n',
        '# Converted\n\nBody v2\n',
      ]);

      await convertDocumentToMarkdown(source, 'docs/Brief.pdf', { runner });
      writeFileSync(source, 'source-v2');
      const regenerated = await convertDocumentToMarkdown(source, 'docs/Brief.pdf', { runner });

      expect(calls.length).toBe(2);
      expect(regenerated.reused).toBe(false);
      expect(regenerated.markdown).toContain('Body v2');
      expect(readFileSync(join(dir, 'Brief.pdf.md'), 'utf8')).toContain('Body v2');
    });
  });

  test('regenerates when the sidecar body was edited by hand', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'Brief.pdf');
      const sidecar = join(dir, 'Brief.pdf.md');
      writeFileSync(source, 'source-v1');
      const { calls, runner } = runnerWriting([
        '# Converted\n\nBody v1\n',
        '# Converted\n\nBody v2\n',
      ]);

      await convertDocumentToMarkdown(source, 'docs/Brief.pdf', { runner });
      writeFileSync(sidecar, readFileSync(sidecar, 'utf8').replace('Body v1', 'Manual edit'));
      const regenerated = await convertDocumentToMarkdown(source, 'docs/Brief.pdf', { runner });

      expect(calls.length).toBe(2);
      expect(regenerated.reused).toBe(false);
      expect(regenerated.markdown).toContain('Body v2');
    });
  });

  test('rejects originals above the document source size cap before conversion', async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, 'Huge.pdf');
      writeFileSync(source, Buffer.alloc(101, 37));

      await expect(convertDocumentToMarkdown(source, 'docs/Huge.pdf', {
        maxSourceBytes: 100,
        runner: async () => {
          throw new Error('runner should not be called for oversized source');
        },
      })).rejects.toThrow('Document too large');
      expect(existsSync(join(dir, 'Huge.pdf.md'))).toBe(false);
    });
  });
});
