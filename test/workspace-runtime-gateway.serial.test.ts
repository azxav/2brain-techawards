import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  getEmbeddingDimensions,
  getEmbeddingModel,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { configureWorkspaceRuntimeGateway } from '../src/workspace/runtime.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

afterEach(() => resetGateway());

describe('Workspace runtime gateway startup', () => {
  test('configures the embedding model and dimensions before schema initialization', async () => {
    await withEnv(
      {
        GBRAIN_HOME: emptyHome(),
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: 'postgresql://gbrain:example@127.0.0.1:5432/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'openrouter:openai/text-embedding-3-small',
        GBRAIN_EMBEDDING_DIMENSIONS: '1536',
        OPENROUTER_API_KEY: 'openrouter-key-example',
      },
      () => {
        configureWorkspaceRuntimeGateway();

        expect(getEmbeddingModel()).toBe(
          'openrouter:openai/text-embedding-3-small',
        );
        expect(getEmbeddingDimensions()).toBe(1536);
      },
    );
  });

  test('configures embeddings when only the runtime database variable is present', async () => {
    await withEnv(
      {
        GBRAIN_HOME: emptyHome(),
        DATABASE_URL: undefined,
        GBRAIN_DATABASE_URL: undefined,
        TWO_BRAIN_DATABASE_URL: 'postgresql://gbrain:example@127.0.0.1:5432/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'openrouter:openai/text-embedding-3-small',
        GBRAIN_EMBEDDING_DIMENSIONS: '1536',
        OPENROUTER_API_KEY: 'openrouter-key-example',
      },
      () => {
        configureWorkspaceRuntimeGateway();

        expect(getEmbeddingModel()).toBe(
          'openrouter:openai/text-embedding-3-small',
        );
        expect(getEmbeddingDimensions()).toBe(1536);
      },
    );
  });

  test('the compiled CLI dispatches the hidden worker entry point', () => {
    const result = Bun.spawnSync(
      [process.execPath, 'run', 'src/cli.ts', 'workspace-runtime', 'worker', '--once'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: '',
          GBRAIN_DATABASE_URL: '',
          TWO_BRAIN_DATABASE_URL: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'TWO_BRAIN_DATABASE_URL is required for a shared 2Brain runtime.',
    );
  });

  test('the hidden worker retains database-free PGLite development mode', () => {
    const home = emptyHome();
    const result = Bun.spawnSync(
      [
        process.execPath,
        'run',
        'src/cli.ts',
        'workspace-runtime',
        'worker',
        '--once',
        '--pglite',
        `${home}/workspace-pglite`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          GBRAIN_HOME: home,
          DATABASE_URL: '',
          GBRAIN_DATABASE_URL: '',
          TWO_BRAIN_DATABASE_URL: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain(
      'GBRAIN_DATABASE_URL is required',
    );
  }, 30_000);
});
