/**
 * v0.37.x — interactive provider picker for `gbrain init`.
 *
 * Mirrors the `init-mode-picker.ts` (v0.32.3) pattern. Runs from
 * `initPGLite()` BEFORE `engine.initSchema()` when env detection finds
 * zero or multiple env-ready providers for the embedding touchpoint
 * (D1=hybrid). Reuses `formatRecipeTable()` from `providers.ts` so the
 * picker's UI and `gbrain providers list` can't drift.
 *
 * Trust contract:
 *  - TTY-only. Callers must not invoke this in non-TTY contexts; D3 says
 *    non-TTY with zero keys exits 1 from `resolveAIOptions` before we
 *    reach here. A defensive guard returns null if no TTY anyway.
 *  - Filters candidates to env-ready recipes (codex finding #3). The
 *    picker is for choosing among providers the user CAN run, not for
 *    walking them through key setup.
 *  - On Ctrl-D / EOF / timeout: returns null, caller treats as exit 1.
 *  - When the user picks a non-Anthropic chat-capable recipe AND
 *    `ANTHROPIC_API_KEY` is missing, prints the subagent caveat from D7
 *    BEFORE returning the choice so the user sees the implication.
 */

import { listRecipes } from '../core/ai/recipes/index.ts';
import { envReady, formatRecipeTable } from './providers.ts';
import { readLineSafe } from './init.ts';
import type { EmbeddingTouchpoint, Recipe } from '../core/ai/types.ts';

export interface PickedProvider {
  recipeId: string;
  modelId: string;
  /** Full `provider:model` string, ready for configureGateway. */
  fullModel: string;
  /** Resolved dim (recipe's `default_dims`). */
  dim: number;
  /** Whether the recipe also covers chat/expansion (informational). */
  hasChat: boolean;
  hasExpansion: boolean;
}

export interface PickProviderOpts {
  /** Touchpoint the picker is selecting for. Embedding is the primary use case. */
  touchpoint: 'embedding' | 'expansion' | 'chat';
  /** Process env to probe. Defaults to process.env (injected for tests). */
  env?: NodeJS.ProcessEnv;
  /** TTY override for tests. Defaults to process.stdin.isTTY. */
  isTTY?: boolean;
  /** Stderr override for tests (capturing prompts). Defaults to process.stderr.write. */
  writeStderr?: (s: string) => void;
}

/**
 * Surface the subagent-Anthropic caveat (D7) when the user picks a
 * non-Anthropic chat-capable recipe without `ANTHROPIC_API_KEY` set.
 *
 * Exported so `initPGLite` can reuse the same message in its post-init
 * stderr summary path (auto-pick branch doesn't run the picker but still
 * needs to surface the caveat). One source of truth keeps the message
 * format aligned across the three D7 surfaces (picker / init summary /
 * doctor).
 */
export function printSubagentAnthropicCaveat(write: (s: string) => void): void {
  write(
    '\n' +
    'Note: subagent features (gbrain dream, gbrain agent run, gbrain autopilot)\n' +
    '      require ANTHROPIC_API_KEY regardless of which chat model you pick.\n' +
    '      Chat alone (gbrain think, gbrain query expansion) works without it.\n' +
    '      Set ANTHROPIC_API_KEY before running those commands.\n\n',
  );
}

/**
 * Filter recipes to those env-ready for the given touchpoint. Returns the
 * filtered list and whether the touchpoint exists on each. Picker UI uses
 * this to refuse picking a recipe whose env isn't ready (codex finding #3).
 */
function readyHostedRecipesForTouchpoint(
  recipes: Recipe[],
  touchpoint: 'embedding' | 'expansion' | 'chat',
  env: NodeJS.ProcessEnv,
): Recipe[] {
  return recipes.filter(r => {
    const tp = r.touchpoints[touchpoint];
    if (!tp) return false;
    // Embedding + chat must have at least one model; expansion just needs to exist.
    if (touchpoint === 'embedding' || touchpoint === 'chat') {
      if (!Array.isArray(tp.models) || tp.models.length === 0) return false;
    }
    if ((r.auth_env?.required ?? []).length === 0) return false;
    return envReady(r, env);
  });
}

interface PickerVariant {
  recipe: Recipe;
  modelId: string;
  dim: number;
}

function embeddingDimsForPicker(tp: EmbeddingTouchpoint): number[] {
  if (Array.isArray(tp.dims_options) && tp.dims_options.length > 0) {
    return [...tp.dims_options];
  }
  return [tp.default_dims];
}

function embeddingVariants(recipe: Recipe): PickerVariant[] {
  const tp = recipe.touchpoints.embedding;
  if (!tp || tp.user_provided_models || !Array.isArray(tp.models) || tp.models.length === 0) {
    return [];
  }
  const dims = embeddingDimsForPicker(tp);
  return tp.models.flatMap((modelId) => dims.map((dim) => ({ recipe, modelId, dim })));
}

function pickerVariants(
  recipes: Recipe[],
  touchpoint: 'embedding' | 'expansion' | 'chat',
): PickerVariant[] {
  if (touchpoint === 'embedding') return recipes.flatMap(embeddingVariants);
  return recipes.flatMap((recipe) => {
    const tp = recipe.touchpoints[touchpoint];
    if (!tp || !('models' in tp) || !Array.isArray(tp.models) || tp.models.length === 0) {
      return [];
    }
    return tp.models.map((modelId) => ({ recipe, modelId, dim: 0 }));
  });
}

/**
 * Pick a provider interactively from env-ready recipes.
 *
 * Returns null when the picker can't proceed (no TTY, no ready recipes,
 * user aborted via Ctrl-D, or readLineSafe timeout). Caller exits 1 on
 * null and prints the no-key fail-loud message itself.
 */
export async function pickProvider(opts: PickProviderOpts): Promise<PickedProvider | null> {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? process.stdin.isTTY ?? false;
  const writeStderr = opts.writeStderr ?? ((s: string) => process.stderr.write(s));

  if (!isTTY) {
    // Defensive — caller should have handled non-TTY before reaching us.
    return null;
  }

  const all = listRecipes();
  const ready = readyHostedRecipesForTouchpoint(all, opts.touchpoint, env);
  const variants = pickerVariants(ready, opts.touchpoint);

  if (ready.length === 0 || variants.length === 0) {
    writeStderr(`\nNo ${opts.touchpoint}-capable providers are env-ready.\n`);
    writeStderr('Set one of the env vars below and re-run init:\n\n');
    writeStderr(formatRecipeTable(all, env) + '\n\n');
    return null;
  }

  writeStderr(`\nPick a ${opts.touchpoint} provider (env-ready providers shown):\n\n`);
  writeStderr(formatRecipeTable(ready, env) + '\n\n');

  // Build numbered options
  const lines = variants.map((variant, i) => {
    const dimLabel = opts.touchpoint === 'embedding' ? ` (${variant.dim}d)` : '';
    return `  ${i + 1}) ${variant.recipe.id}:${variant.modelId}${dimLabel}`;
  });
  writeStderr(lines.join('\n') + '\n\n');

  const answer = await readLineSafe(
    `Choice [1-${variants.length}, default 1]: `,
    '1',
    /* timeoutMs */ 60_000,
  );

  const choice = parseInt(answer.trim(), 10);
  if (!Number.isFinite(choice) || choice < 1 || choice > variants.length) {
    writeStderr(`\nInvalid choice "${answer}". Aborting.\n`);
    return null;
  }

  const picked = variants[choice - 1];

  // D7: surface the subagent-Anthropic caveat when picking a non-Anthropic
  // chat-capable recipe without ANTHROPIC_API_KEY set.
  const isChatTouchpoint = opts.touchpoint === 'chat';
  const isAnthropic = picked.recipe.id === 'anthropic';
  const anthropicKeySet = !!env.ANTHROPIC_API_KEY;
  if (isChatTouchpoint && !isAnthropic && !anthropicKeySet) {
    printSubagentAnthropicCaveat(writeStderr);
  }

  return {
    recipeId: picked.recipe.id,
    modelId: picked.modelId,
    fullModel: `${picked.recipe.id}:${picked.modelId}`,
    dim: picked.dim,
    hasChat: !!picked.recipe.touchpoints.chat && (picked.recipe.touchpoints.chat.models?.length ?? 0) > 0,
    hasExpansion: !!picked.recipe.touchpoints.expansion,
  };
}
