import { afterEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

describe('NVIDIA Nemotron halfvec PGLite integration', () => {
  afterEach(() => resetGateway());

  test('fresh schema uses halfvec(2048) and upsertChunks writes 2048d embeddings', async () => {
    configureGateway({
      embedding_model: 'nvidia:llama-nemotron-embed-1b-v2',
      embedding_dimensions: 2048,
      env: { NVIDIA_API_KEY: 'test-key' },
    });

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    try {
      await engine.initSchema();

      const typeRows = await engine.executeRaw<{ formatted: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'content_chunks'
            AND a.attname = 'embedding'
            AND NOT a.attisdropped`,
      );
      expect(typeRows[0]?.formatted).toBe('halfvec(2048)');

      await engine.executeRaw(
        `INSERT INTO pages (slug, type, title, compiled_truth, timeline)
         VALUES ('test/nvidia-halfvec', 'note', 'NVIDIA halfvec', 'hello', '')`,
      );

      const embedding = new Float32Array(2048);
      embedding.fill(0.125);
      await engine.upsertChunks('test/nvidia-halfvec', [{
        chunk_index: 0,
        chunk_text: 'hello',
        chunk_source: 'compiled_truth',
        embedding,
        model: 'nvidia:llama-nemotron-embed-1b-v2',
        token_count: 1,
      }]);

      const rows = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM content_chunks
          WHERE model = 'nvidia:llama-nemotron-embed-1b-v2'
            AND embedding IS NOT NULL`,
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(1);
    } finally {
      await engine.disconnect();
    }
  });
});
