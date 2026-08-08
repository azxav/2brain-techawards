import { describe, expect, test } from 'bun:test';
import { resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { getRecipe, RECIPES } from '../../src/core/ai/recipes/index.ts';
import { nvidia } from '../../src/core/ai/recipes/nvidia.ts';

describe('NVIDIA embedding recipe', () => {
  test('is registered under provider id nvidia', () => {
    expect(RECIPES.has('nvidia')).toBe(true);
    expect(getRecipe('nvidia')).toBe(nvidia);
  });

  test('uses the NVIDIA-hosted OpenAI-compatible endpoint and auth env', () => {
    expect(nvidia.implementation).toBe('openai-compatible');
    expect(nvidia.base_url_default).toBe('https://integrate.api.nvidia.com/v1');
    expect(nvidia.auth_env?.required).toEqual(['NVIDIA_API_KEY']);
  });

  test('declares NVIDIA embedding metadata', () => {
    const embedding = nvidia.touchpoints.embedding;
    expect(embedding?.models).toContain('llama-nemotron-embed-1b-v2');
    expect(embedding?.models).not.toContain('nv-embed-v1');
    expect(embedding?.default_dims).toBe(2048);
    expect(embedding?.dims_options).toEqual([384, 512, 768, 1024, 2048]);
    expect(embedding?.dims_options).toContain(1024);
    expect(embedding?.dims_options).toContain(2048);
    expect(embedding?.max_batch_tokens).toBe(8192);
    expect(embedding?.chars_per_token).toBe(1);
    expect(embedding?.safety_factor).toBe(0.5);
    expect(embedding?.supports_multimodal).toBe(false);
  });

  test('resolves Nemotron friendly model id to clean config model id', () => {
    const { parsed } = resolveRecipe('nvidia:llama-nemotron-embed-1b-v2');
    expect(parsed.providerId).toBe('nvidia');
    expect(parsed.modelId).toBe('llama-nemotron-embed-1b-v2');
  });

  test('normalizes wire-form aliases back to clean config ids', () => {
    expect(resolveRecipe('nvidia:nvidia/llama-nemotron-embed-1b-v2').parsed.modelId).toBe('llama-nemotron-embed-1b-v2');
  });
});
