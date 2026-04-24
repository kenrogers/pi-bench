export interface OpenRouterModelSummary {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  supported_parameters?: string[];
  top_provider?: {
    max_completion_tokens?: number | null;
  };
}

export interface OpenRouterModelMatch {
  model: OpenRouterModelSummary;
  candidates: OpenRouterModelSummary[];
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelSummary[];
}

let cachedModels: { at: number; models: OpenRouterModelSummary[] } | undefined;

const cacheMs = 5 * 60 * 1000;

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const compact = (value: string): string => normalize(value).replace(/\s+/g, "");

const getOpenRouterModels = async (): Promise<OpenRouterModelSummary[]> => {
  if (cachedModels && Date.now() - cachedModels.at < cacheMs) {
    return cachedModels.models;
  }

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      "HTTP-Referer": "https://github.com/badlogic/pi-bench",
      "X-Title": "Pi-Bench",
    },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model search failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as OpenRouterModelsResponse;
  const models = Array.isArray(body.data) ? body.data.filter((model) => typeof model.id === "string") : [];
  cachedModels = { at: Date.now(), models };
  return models;
};

const scoreModel = (query: string, model: OpenRouterModelSummary): number => {
  const haystack = normalize(`${model.id} ${model.name ?? ""}`);
  const haystackCompact = compact(`${model.id} ${model.name ?? ""}`);
  const queryNorm = normalize(query);
  const queryCompact = compact(query);
  const tokens = queryNorm.split(" ").filter(Boolean);

  if (!queryNorm || tokens.length === 0) return 0;
  if (model.id.toLowerCase() === query.toLowerCase()) return 10000;
  if ((model.name ?? "").toLowerCase() === query.toLowerCase()) return 9500;
  if (haystack === queryNorm) return 9000;
  if (haystackCompact === queryCompact) return 8500;

  const tokenHits = tokens.filter((token) => haystack.includes(token)).length;
  if (tokenHits === 0) return 0;

  let score = tokenHits * 100;
  if (tokenHits === tokens.length) score += 1000;
  if (haystack.includes(queryNorm)) score += 600;
  if (haystackCompact.includes(queryCompact)) score += 400;
  if (model.id.toLowerCase().startsWith(query.toLowerCase())) score += 300;
  if (model.name?.toLowerCase().startsWith(query.toLowerCase())) score += 250;

  const created = typeof model.created === "number" ? model.created : 0;
  score += Math.min(100, Math.max(0, created / 100000000));

  return score;
};

export const searchOpenRouterModels = async (query: string): Promise<OpenRouterModelMatch | undefined> => {
  const models = await getOpenRouterModels();
  const scored = models
    .map((model) => ({ model, score: scoreModel(query, model) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return undefined;

  return {
    model: best.model,
    candidates: scored.slice(0, 5).map((match) => match.model),
  };
};
