import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearActiveRun, createRun, getActiveRun, getBenchRoot, listRuns, recordRunEvent, scoreRun, setActiveRun } from "./pibench/core.js";
import { type OpenRouterModelSummary, searchOpenRouterModels } from "./pibench/openrouter-models.js";
import { describeRun, formatComparison, formatHistory, formatRunResult, formatStatus, formatSuggestions } from "./pibench/report.js";
import type { BenchRunResult } from "./pibench/types.js";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
type PiBenchContext = Pick<CommandContext, "cwd" | "hasUI" | "model" | "modelRegistry" | "ui">;

type CompareBatch = {
  id: string;
  suite: string;
  cwd: string;
  seed: string;
  modelQueries: string[];
  nextIndex: number;
  currentRunId?: string;
  results: BenchRunResult[];
};

let activeCompareBatch: CompareBatch | undefined;

const knownSuites = new Set(["quick"]);

const parseArgs = (args: string): string[] => args.trim().split(/\s+/).filter(Boolean);

const parseRunArgs = (args: string): { suite: string; modelQuery?: string } => {
  const parts = parseArgs(args);
  const [first, ...rest] = parts;
  if (!first) {
    return { suite: "quick" };
  }

  if (knownSuites.has(first)) {
    return { suite: first, modelQuery: rest.join(" ") || undefined };
  }

  return { suite: "quick", modelQuery: parts.join(" ") };
};

export const parseCompareArgs = (args: string): { suite: string; modelQueries: string[] } => {
  const trimmed = args.trim();
  if (!trimmed) return { suite: "quick", modelQueries: [] };
  const parts = parseArgs(trimmed);
  const first = parts[0];
  const suite = first && knownSuites.has(first) ? first : "quick";
  const queryText = suite === first ? trimmed.slice(first.length).trim() : trimmed;
  return { suite, modelQueries: splitModelQueries(queryText) };
};

export const splitModelQueries = (queryText: string): string[] => {
  return queryText
    .split(/\s+(?:vs|versus)\s+|\s*[|,]\s*/i)
    .map((query) => query.trim())
    .filter(Boolean);
};

const runCommand = async (pi: ExtensionAPI, args: string, ctx: CommandContext) => {
  await ctx.waitForIdle();
  if (getActiveRun() || activeCompareBatch) {
    ctx.ui.notify("A Pi-Bench run is already active. Finish it before starting another run.", "warning");
    return;
  }

  const { suite, modelQuery } = parseRunArgs(args);
  const modelQueries = modelQuery ? splitModelQueries(modelQuery) : [];
  if (modelQueries.length > 1) {
    await startCompareBatch(pi, ctx, suite, modelQueries);
    return;
  }

  const selectedModel = await selectOpenRouterModel(pi, ctx, modelQuery);
  if (!selectedModel) return;

  const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
  if (!openRouterApiKey) return;

  const ok = await pi.setModel(selectedModel);
  if (!ok) {
    ctx.ui.notify(`Pi-Bench found ${formatModelLabel(selectedModel)}, but Pi has no usable OpenRouter API key for it.`, "error");
    return;
  }

  const run = await createRun({
    suite,
    cwd: ctx.cwd,
    modelLabel: formatModelLabel(selectedModel),
    setupLabel: "current-pi-setup",
  });

  setActiveRun(run.id);
  pi.setSessionName(`Pi-Bench ${run.suite} ${run.id}`);
  pi.appendEntry("pibench-run-start", run);
  ctx.ui.setStatus("pi-bench", `Pi-Bench ${run.suite} running`);
  ctx.ui.notify(`Pi-Bench run ${run.id} created`, "info");

  pi.sendUserMessage(describeRun(run));
};

const compareCommand = async (pi: ExtensionAPI, args: string, ctx: CommandContext) => {
  await ctx.waitForIdle();
  if (getActiveRun() || activeCompareBatch) {
    ctx.ui.notify("A Pi-Bench run is already active. Finish it before starting a comparison.", "warning");
    return;
  }

  const { suite, modelQueries } = parseCompareArgs(args);
  if (modelQueries.length < 2) {
    ctx.ui.notify("Usage: /pibench compare [suite] model one vs model two [vs model three]", "warning");
    return;
  }

  await startCompareBatch(pi, ctx, suite, modelQueries);
};

const startCompareBatch = async (
  pi: ExtensionAPI,
  ctx: PiBenchContext,
  suite: string,
  modelQueries: string[],
) => {
  const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
  if (!openRouterApiKey) return;

  activeCompareBatch = {
    id: buildCompareId(),
    suite,
    cwd: ctx.cwd,
    seed: buildCompareId(),
    modelQueries,
    nextIndex: 0,
    results: [],
  };

  ctx.ui.notify(`Pi-Bench comparison started for ${modelQueries.length} models.`, "info");
  await startNextCompareRun(pi, ctx);
};

const doctorCommand = async (ctx: CommandContext): Promise<string> => {
  const lines = ["Pi-Bench doctor", ""];
  const benchRoot = getBenchRoot();
  lines.push(`Bench root: ${benchRoot}`);

  try {
    await mkdir(benchRoot, { recursive: true });
    const probe = path.join(benchRoot, ".doctor");
    await writeFile(probe, String(Date.now()));
    await unlink(probe);
    lines.push("- Storage: ok");
  } catch (error) {
    lines.push(`- Storage: failed (${error instanceof Error ? error.message : String(error)})`);
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  lines.push(`- Pi models available: ${availableModels.length}`);
  lines.push(`- Current model: ${ctx.model ? formatModelLabel(ctx.model) : "unknown"}`);

  try {
    const openRouterKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
    lines.push(`- OpenRouter key in Pi: ${openRouterKey ? "found" : "not found"}`);
  } catch (error) {
    lines.push(`- OpenRouter key check: failed (${error instanceof Error ? error.message : String(error)})`);
  }

  lines.push("");
  lines.push("Try: /pibench run quick deepseek 4 flash");
  return lines.join("\n");
};

const buildCompareId = () => {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
};

const openRouterModelId = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
};

const formatModelLabel = (model: Pick<Model<any>, "provider" | "id">): string => `${model.provider}/${model.id}`;

const isOpenRouterModel = (model: Model<any>): boolean => {
  return model.provider === "openrouter" || model.provider === "openrouter-live" || model.baseUrl.includes("openrouter.ai");
};

const findExactOpenRouterModel = (ctx: PiBenchContext, query: string): Model<any> | undefined => {
  return ctx.modelRegistry.find("openrouter", openRouterModelId(query));
};

const costPerMillionTokens = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
};

const openRouterInputTypes = (model: OpenRouterModelSummary): ("text" | "image")[] => {
  const modalities = model.architecture?.input_modalities ?? ["text"];
  return modalities.includes("image") ? ["text", "image"] : ["text"];
};

const openRouterSupportsReasoning = (model: OpenRouterModelSummary): boolean => {
  const params = model.supported_parameters ?? [];
  return params.includes("reasoning") || params.includes("include_reasoning") || params.includes("reasoning_effort");
};

const registerBenchOpenRouterModel = (
  pi: ExtensionAPI,
  ctx: PiBenchContext,
  model: Model<any>,
  apiKey: string,
): Model<any> | undefined => {
  pi.registerProvider("openrouter-live", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: {
          ...model.compat,
          thinkingFormat: "openrouter",
        },
      },
    ],
  });

  return ctx.modelRegistry.find("openrouter-live", model.id);
};

const registerLiveOpenRouterModel = (
  pi: ExtensionAPI,
  ctx: PiBenchContext,
  model: OpenRouterModelSummary,
  apiKey: string,
): Model<any> | undefined => {
  pi.registerProvider("openrouter-live", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    api: "openai-completions",
    models: [
      {
        id: model.id,
        name: model.name ?? model.id,
        reasoning: openRouterSupportsReasoning(model),
        input: openRouterInputTypes(model),
        cost: {
          input: costPerMillionTokens(model.pricing?.prompt),
          output: costPerMillionTokens(model.pricing?.completion),
          cacheRead: costPerMillionTokens(model.pricing?.input_cache_read),
          cacheWrite: costPerMillionTokens(model.pricing?.input_cache_write),
        },
        contextWindow: model.context_length ?? 128000,
        maxTokens: model.top_provider?.max_completion_tokens ?? 16384,
        compat: {
          thinkingFormat: "openrouter",
        },
      },
    ],
  });

  return ctx.modelRegistry.find("openrouter-live", model.id);
};

const ensureOpenRouterApiKey = async (ctx: PiBenchContext): Promise<string | undefined> => {
  const existing = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
  if (existing) return existing;

  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Pi-Bench needs an OpenRouter API key. Run Pi interactively, use Pi's /login flow, or set OPENROUTER_API_KEY.",
      "error",
    );
    return undefined;
  }

  const entered = await ctx.ui.input("OpenRouter API key", "sk-or-v1-...");
  const apiKey = entered?.trim();
  if (!apiKey) {
    ctx.ui.notify("Pi-Bench run cancelled: no OpenRouter API key was entered.", "warning");
    return undefined;
  }

  ctx.modelRegistry.authStorage.set("openrouter", { type: "api_key", key: apiKey });
  ctx.ui.notify("OpenRouter key saved to Pi auth storage.", "info");
  return apiKey;
};

const promptForOpenRouterModelQuery = async (ctx: PiBenchContext): Promise<string | undefined> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Pi-Bench needs an OpenRouter model. Try: /pibench run quick deepseek 4 flash", "error");
    return undefined;
  }

  const entered = await ctx.ui.input("OpenRouter model", "deepseek 4 flash");
  const query = entered?.trim();
  if (!query) {
    ctx.ui.notify("Pi-Bench run cancelled: no OpenRouter model was selected.", "warning");
    return undefined;
  }
  return query;
};

const selectOpenRouterModel = async (
  pi: ExtensionAPI,
  ctx: PiBenchContext,
  modelQuery: string | undefined,
): Promise<Model<any> | undefined> => {
  if (modelQuery) {
    return resolveOpenRouterModel(pi, ctx, modelQuery);
  }

  if (ctx.model && isOpenRouterModel(ctx.model)) {
    const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
    if (!openRouterApiKey) return undefined;
    const benchModel = registerBenchOpenRouterModel(pi, ctx, ctx.model, openRouterApiKey);
    if (benchModel) {
      ctx.ui.notify(`Pi-Bench will use ${formatModelLabel(benchModel)}.`, "info");
    }
    return benchModel;
  }

  const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
  if (!openRouterApiKey) return undefined;

  const promptedQuery = await promptForOpenRouterModelQuery(ctx);
  if (!promptedQuery) return undefined;

  return resolveOpenRouterModel(pi, ctx, promptedQuery);
};

const resolveOpenRouterModel = async (
  pi: ExtensionAPI,
  ctx: PiBenchContext,
  query: string,
): Promise<Model<any> | undefined> => {
  const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
  if (!openRouterApiKey) return undefined;

  const exactLocalMatch = findExactOpenRouterModel(ctx, query);
  if (exactLocalMatch) {
    const benchModel = registerBenchOpenRouterModel(pi, ctx, exactLocalMatch, openRouterApiKey);
    if (benchModel) {
      ctx.ui.notify(`Pi-Bench matched "${query}" to ${formatModelLabel(benchModel)}.`, "info");
    }
    return benchModel;
  }

  let openRouterMatch;
  try {
    openRouterMatch = await searchOpenRouterModels(query);
  } catch (error) {
    ctx.ui.notify(
      `Pi-Bench could not search OpenRouter models: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return undefined;
  }

  if (!openRouterMatch) {
    ctx.ui.notify(`Pi-Bench could not find a Pi or OpenRouter model matching "${query}".`, "error");
    return undefined;
  }

  const resolvedId = openRouterMatch.model.id;
  const existingModel = ctx.modelRegistry.find("openrouter", resolvedId);
  if (existingModel) {
    const benchModel = registerBenchOpenRouterModel(pi, ctx, existingModel, openRouterApiKey);
    if (benchModel) {
      ctx.ui.notify(`Pi-Bench matched "${query}" to ${formatModelLabel(benchModel)}.`, "info");
    }
    return benchModel;
  }

  const liveModel = registerLiveOpenRouterModel(pi, ctx, openRouterMatch.model, openRouterApiKey);
  if (liveModel) {
    ctx.ui.notify(`Pi-Bench matched "${query}" to live OpenRouter model ${resolvedId}.`, "info");
    return liveModel;
  }

  return undefined;
};

const startNextCompareRun = async (pi: ExtensionAPI, ctx: PiBenchContext) => {
  const batch = activeCompareBatch;
  if (!batch) return;

  while (batch.nextIndex < batch.modelQueries.length) {
    const modelNumber = batch.nextIndex + 1;
    const query = batch.modelQueries[batch.nextIndex];
    batch.nextIndex += 1;

    const selectedModel = await resolveOpenRouterModel(pi, ctx, query);
    if (!selectedModel) {
      ctx.ui.notify(`Pi-Bench comparison skipped "${query}" because no OpenRouter model matched.`, "warning");
      continue;
    }

    const ok = await pi.setModel(selectedModel);
    if (!ok) {
      ctx.ui.notify(`Pi-Bench comparison skipped ${formatModelLabel(selectedModel)} because Pi could not use its OpenRouter key.`, "warning");
      continue;
    }

    const run = await createRun({
      suite: batch.suite,
      cwd: batch.cwd,
      modelLabel: formatModelLabel(selectedModel),
      setupLabel: `compare-${batch.id}`,
      seed: batch.seed,
    });

    batch.currentRunId = run.id;
    setActiveRun(run.id);
    pi.setSessionName(`Pi-Bench compare ${modelNumber}/${batch.modelQueries.length}`);
    pi.appendEntry("pibench-run-start", run);
    ctx.ui.setStatus("pi-bench", `Pi-Bench compare ${modelNumber}/${batch.modelQueries.length}`);
    ctx.ui.notify(`Pi-Bench comparison run ${modelNumber}/${batch.modelQueries.length}: ${formatModelLabel(selectedModel)}`, "info");

    pi.sendUserMessage([
      `Pi-Bench comparison ${modelNumber}/${batch.modelQueries.length}.`,
      `All comparison runs use shared task seed ${batch.seed}.`,
      "",
      describeRun(run),
    ].join("\n"));
    return;
  }

  const results = batch.results;
  activeCompareBatch = undefined;
  clearActiveRun();
  ctx.ui.setStatus("pi-bench", undefined);
  ctx.ui.notify(formatComparison(results), "info");
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const patchDeepSeekReasoningContent = (payload: unknown): unknown | undefined => {
  if (!isRecord(payload)) return undefined;
  const modelId = typeof payload.model === "string" ? payload.model.toLowerCase() : "";
  if (!modelId.includes("deepseek")) return undefined;
  if (!Array.isArray(payload.messages)) return undefined;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      typeof message.reasoning !== "string" ||
      typeof message.reasoning_content === "string"
    ) {
      return message;
    }

    changed = true;
    return { ...message, reasoning_content: message.reasoning };
  });

  return changed ? { ...payload, messages } : undefined;
};

export default function piBenchExtension(pi: ExtensionAPI) {
  pi.registerCommand("pibench", {
    description: "Run and inspect local Pi-Bench coding trials",
    getArgumentCompletions(prefix: string) {
      const options = [
        "run quick",
        "run quick openrouter/qwen/qwen3-coder",
        "run deepseek",
        "compare quick deepseek 4 flash vs qwen/qwen3-coder",
        "doctor",
        "history",
        "suggest",
        "status",
        "score",
      ];
      return options
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = parseArgs(args);
      const restArgs = rest.join(" ");

      if (!subcommand || subcommand === "status") {
        ctx.ui.notify(formatStatus(getActiveRun()), "info");
        return;
      }

      if (subcommand === "run") {
        await runCommand(pi, restArgs, ctx);
        return;
      }

      if (subcommand === "compare") {
        await compareCommand(pi, restArgs, ctx);
        return;
      }

      if (subcommand === "history") {
        ctx.ui.notify(formatHistory(await listRuns()), "info");
        return;
      }

      if (subcommand === "suggest") {
        ctx.ui.notify(formatSuggestions(await listRuns()), "info");
        return;
      }

      if (subcommand === "doctor") {
        ctx.ui.notify(await doctorCommand(ctx), "info");
        return;
      }

      if (subcommand === "score") {
        const activeRun = getActiveRun();
        if (!activeRun) {
          ctx.ui.notify("No active Pi-Bench run. Start one with /pibench run quick.", "warning");
          return;
        }
        const result = await scoreRun(activeRun.id);
        pi.appendEntry("pibench-run-result", result);
        if (activeCompareBatch?.currentRunId === activeRun.id) {
          activeCompareBatch.results.push(result);
          activeCompareBatch.currentRunId = undefined;
          clearActiveRun();
          await startNextCompareRun(pi, ctx);
          return;
        }
        clearActiveRun();
        ctx.ui.setStatus("pi-bench", `Pi-Bench complete ${result.score}/100`);
        ctx.ui.notify(formatRunResult(result), result.passed ? "info" : "warning");
        return;
      }

      ctx.ui.notify("Usage: /pibench run [suite] [model query] | compare [suite] model one vs model two | doctor | history | suggest | status | score", "warning");
    },
  });

  pi.registerTool({
    name: "pibench_submit",
    label: "Submit Pi-Bench Run",
    description: "Submit the active Pi-Bench run for scoring after completing the generated task.",
    promptSnippet: "Submit the active Pi-Bench run for scoring.",
    promptGuidelines: [
      "Use pibench_submit only after you have fixed the Pi-Bench task and run the visible tests.",
    ],
    parameters: Type.Object({
      notes: Type.Optional(Type.String({ description: "Brief notes about the fix and tests that were run." })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const activeRun = getActiveRun();
      if (!activeRun) {
        return {
          isError: true,
          content: [{ type: "text", text: "No active Pi-Bench run. Start one with /pibench run quick." }],
          details: {},
        };
      }

      onUpdate?.({ content: [{ type: "text", text: "Scoring Pi-Bench run..." }], details: {} });
      const result = await scoreRun(activeRun.id, params.notes);
      pi.appendEntry("pibench-run-result", result);
      ctx.ui.setStatus("pi-bench", `Pi-Bench complete ${result.score}/100`);
      if (activeCompareBatch?.currentRunId === activeRun.id) {
        activeCompareBatch.results.push(result);
      }

      return {
        content: [{ type: "text", text: formatRunResult(result) }],
        details: result,
      };
    },
  });

  pi.on("tool_call", async (event) => {
    await recordRunEvent({
      type: "tool_call",
      at: Date.now(),
      toolName: event.toolName,
      input: event.input,
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    await recordRunEvent({
      type: "tool_result",
      at: Date.now(),
      toolName: event.toolName,
      isError: event.isError,
    });

    if (event.toolName === "pibench_submit" && !event.isError) {
      const shouldContinueCompare = activeCompareBatch?.currentRunId === getActiveRun()?.id;
      if (activeCompareBatch && shouldContinueCompare) {
        activeCompareBatch.currentRunId = undefined;
      }
      clearActiveRun();
      if (shouldContinueCompare) {
        setTimeout(() => {
          void startNextCompareRun(pi, ctx);
        }, 0);
      }
    }
  });

  pi.on("after_provider_response", async (event) => {
    if (event.status < 400) return;
    await recordRunEvent({
      type: "provider_response",
      at: Date.now(),
      status: event.status,
      isError: true,
    });
  });

  pi.on("before_provider_request", async (event) => {
    if (!getActiveRun()) return undefined;
    return patchDeepSeekReasoningContent(event.payload);
  });

  pi.on("model_select", async (event, ctx) => {
    const activeRun = getActiveRun();
    if (!activeRun) return;
    activeRun.modelLabel = `${event.model.provider}/${event.model.id}`;
    ctx.ui.setStatus("pi-bench", `Pi-Bench model ${activeRun.modelLabel}`);
  });
}
