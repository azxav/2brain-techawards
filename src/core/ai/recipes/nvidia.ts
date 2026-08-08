import type { Recipe } from '../types.ts';

/**
 * NVIDIA-hosted Llama Nemotron Embed through the NIM OpenAI-compatible API.
 *
 * NVIDIA documents the model at a native 2048 embedding dimension with dynamic
 * output dimensions. The /v1/embeddings endpoint also requires `input_type`:
 * `passage` for document/index embeddings and `query` for query embeddings.
 * The gateway threads that field in dimsProviderOptions().
 */
export const nvidia: Recipe = {
  id: 'nvidia',
  name: 'NVIDIA NIM',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://integrate.api.nvidia.com/v1',
  auth_env: {
    required: ['NVIDIA_API_KEY'],
    setup_url: 'https://build.nvidia.com/nvidia/llama-nemotron-embed-1b-v2',
  },
  aliases: {
    'nvidia/llama-nemotron-embed-1b-v2': 'llama-nemotron-embed-1b-v2',
  },
  touchpoints: {
    embedding: {
      models: ['llama-nemotron-embed-1b-v2'],
      default_dims: 2048,
      dims_options: [384, 512, 768, 1024, 2048],
      max_batch_tokens: 8192,
      chars_per_token: 1,
      safety_factor: 0.5,
      supports_multimodal: false,
    },
  },
  setup_hint:
    'Get an API key at https://build.nvidia.com/nvidia/llama-nemotron-embed-1b-v2, then `export NVIDIA_API_KEY=...`',
};
