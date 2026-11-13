// The model catalog the mock serves.
//
// This mirrors the public catalog as checked on 2026-11-07
// (https://molochai.dev/models?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-api).
// It is test data for the mock only: real
// clients must fetch GET /models instead of hardcoding this list, because the
// catalog and the build behind each id can change.

export const MODELS = Object.freeze([
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', reasoning: true },
  { id: 'glm-4.7-flash-uncensored', name: 'GLM-4.7-Flash-Uncensored', reasoning: true },
  { id: 'gemma4-26b-a4b-qat', name: 'Gemma4-26B-A4B-QAT', reasoning: true },
  { id: 'qwen3.8-27b-uncensored', name: 'Qwen3.8-27B-Uncensored', reasoning: true },
  {
    id: 'llama-3.3-70b-instruct-abliterated',
    name: 'Llama-3.3-70B-Instruct-abliterated-GGUF',
    reasoning: false,
  },
]);

export const MODEL_IDS = Object.freeze(MODELS.map((m) => m.id));

/** The context limit the mock reports, the smallest plan limit. */
export const MOCK_CONTEXT_LIMIT = 65536;

export function findModel(id) {
  return MODELS.find((m) => m.id === id);
}

/**
 * GET /api/v1/models body. `name` and `available` are MolochAI extensions to
 * the OpenAI list format.
 */
export function modelList(unavailable) {
  return {
    object: 'list',
    data: MODELS.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'molochai',
      name: m.name,
      available: !unavailable.has(m.id),
    })),
  };
}
