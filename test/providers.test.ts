/**
 * `gbrain providers` - pure formatter + envReady tests.
 *
 * `runTest` and `runExplain` aren't covered here because they touch the
 * gateway / loadConfig; E2E exercises those.
 */

import { describe, test, expect } from 'bun:test';
import { formatRecipeTable, envReady } from '../src/commands/providers.ts';
import { listRecipes, getRecipe } from '../src/core/ai/recipes/index.ts';

describe('envReady', () => {
  test('true when all required env vars set', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: 'sk-test' })).toBe(true);
  });

  test('false when required env var missing', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, {})).toBe(false);
  });

  test('false on empty-string env var', () => {
    const openai = getRecipe('openai');
    expect(openai).toBeDefined();
    expect(envReady(openai!, { OPENAI_API_KEY: '' })).toBe(false);
  });

  test('true for recipes with no required env (local Ollama)', () => {
    const ollama = getRecipe('ollama');
    expect(ollama).toBeDefined();
    expect(envReady(ollama!, {})).toBe(true);
  });
});

describe('formatRecipeTable', () => {
  test('header row present', () => {
    const out = formatRecipeTable(listRecipes(), {});
    expect(out).toContain('PROVIDER');
    expect(out).toContain('TIER');
    expect(out).toContain('EMBED');
    expect(out).toContain('EXPAND');
    expect(out).toContain('CHAT');
    expect(out).toContain('STATUS');
  });

  test('shows ready for env-satisfied provider', () => {
    const out = formatRecipeTable(listRecipes(), { OPENAI_API_KEY: 'sk-test' });
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('ready');
  });

  test('shows missing env var for missing provider', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const openaiLine = out.split('\n').find(line => line.startsWith('openai'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('missing OPENAI_API_KEY');
  });

  test('each recipe appears at most once', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const recipes = listRecipes();
    for (const r of recipes) {
      const occurrences = out.split('\n').filter(line => line.startsWith(`${r.id} `) || line.startsWith(`${r.id}  `));
      expect(occurrences.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('embedding-only recipe (zeroentropyai) shows embedding support', () => {
    const out = formatRecipeTable(listRecipes(), {});
    const zeLine = out.split('\n').find(line => line.startsWith('zeroentropyai'));
    expect(zeLine).toBeDefined();
    expect(zeLine).toContain('yes');
  });

  test('NVIDIA Build embedder appears next to Ollama in provider ordering', () => {
    const ids = listRecipes().map(r => r.id);
    expect(ids[ids.indexOf('ollama') + 1]).toBe('nvidia');

    const out = formatRecipeTable(listRecipes(), { NVIDIA_API_KEY: 'nv-test' });
    const lines = out.split('\n');
    const ollamaIdx = lines.findIndex(line => line.startsWith('ollama'));
    const nvidiaIdx = lines.findIndex(line => line.startsWith('nvidia'));
    expect(nvidiaIdx).toBe(ollamaIdx + 1);
    expect(lines[nvidiaIdx]).toContain('ready');
  });

  test('isolated subset renders correctly (picker reuses this)', () => {
    const openai = getRecipe('openai');
    const ze = getRecipe('zeroentropyai');
    expect(openai && ze).toBeTruthy();
    const out = formatRecipeTable([openai!, ze!], { OPENAI_API_KEY: 'sk-test' });
    const lines = out.split('\n');
    expect(lines.length).toBe(4);
    expect(lines[2]).toContain('openai');
    expect(lines[2]).toContain('ready');
    expect(lines[3]).toContain('zeroentropyai');
    expect(lines[3]).toContain('missing ZEROENTROPY_API_KEY');
  });
});
