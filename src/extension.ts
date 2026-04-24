import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearActiveRun, createRun, getActiveRun, getBenchRoot, listRuns, recordRunEvent, scoreRun, setActiveRun } from "./pibench/core.js";
import { type OpenRouterModelSummary, searchOpenRouterModels } from "./pibench/openrouter-models.js";
import { describeRun, formatHistory, formatRunResult, formatStatus, formatSuggestions } from "./pibench/report.js";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

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

const runCommand = async (pi: ExtensionAPI, args: string, ctx: CommandContext) => {
  await ctx.waitForIdle();

  const { suite, modelQuery } = parseRunArgs(args);

  const selectedModel = modelQuery ? await resolveModel(pi, ctx, modelQuery) : undefined;
  if (modelQuery && !selectedModel) return;

  if (selectedModel) {
    const ok = await pi.setModel(selectedModel);
    if (!ok) {
      ctx.ui.notify(`Pi-Bench found ${formatModelLabel(selectedModel)}, but Pi has no usable API key for it.`, "error");
      return;
    }
  }

  const run = await createRun({
    suite,
    cwd: ctx.cwd,
    modelLabel: selectedModel ? formatModelLabel(selectedModel) : ctx.model ? formatModelLabel(ctx.model) : "unknown",
    setupLabel: "current-pi-setup",
  });

  setActiveRun(run.id);
  pi.setSessionName(`Pi-Bench ${run.suite} ${run.id}`);
  pi.appendEntry("pibench-run-start", run);
  ctx.ui.setStatus("pi-bench", `Pi-Bench ${run.suite} running`);
  ctx.ui.notify(`Pi-Bench run ${run.id} created`, "info");

  pi.sendUserMessage(describeRun(run));
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

const splitModel = (value: string): [string, string] => {
  const parts = value.split("/");
  if (parts.length < 2) {
    return ["openrouter", value];
  }
  if (parts[0] === "openrouter") {
    return ["openrouter", parts.slice(1).join("/")];
  }
  return [parts[0], parts.slice(1).join("/")];
};

const formatModelLabel = (model: Pick<Model<any>, "provider" | "id">): string => `${model.provider}/${model.id}`;

const fuzzyScore = (query: string, model: Pick<Model<any>, "provider" | "id" | "name">): number => {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  const queryNorm = normalize(query);
  const haystack = normalize(`${model.provider}/${model.id} ${model.id} ${model.name}`);
  const queryCompact = queryNorm.replace(/\s+/g, "");
  const haystackCompact = haystack.replace(/\s+/g, "");
  const tokens = queryNorm.split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;

  if (formatModelLabel(model).toLowerCase() === query.toLowerCase()) return 10000;
  if (model.id.toLowerCase() === query.toLowerCase()) return 9500;
  if (model.name.toLowerCase() === query.toLowerCase()) return 9000;
  if (haystackCompact === queryCompact) return 8500;

  const tokenHits = tokens.filter((token) => haystack.includes(token)).length;
  if (tokenHits === 0) return 0;

  let score = tokenHits * 100;
  if (tokenHits === tokens.length) score += 1000;
  if (haystack.includes(queryNorm)) score += 500;
  if (haystackCompact.includes(queryCompact)) score += 300;
  return score;
};

const findExactAvailableModel = (ctx: CommandContext, query: string): Model<any> | undefined => {
  const exact = ctx.modelRegistry.find(...splitModel(query));
  if (exact) return exact;

  const [provider, id] = splitModel(query);
  const providerlessExact = provider === "openrouter" ? ctx.modelRegistry.find("openrouter", id) : undefined;
  if (providerlessExact) return providerlessExact;

  return undefined;
};

const findFuzzyAvailableModel = (ctx: CommandContext, query: string): Model<any> | undefined => {
  const candidates = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({ model, score: fuzzyScore(query, model) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.model;
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

const registerLiveOpenRouterModel = async (
  pi: ExtensionAPI,
  ctx: CommandContext,
  model: OpenRouterModelSummary,
): Promise<Model<any> | undefined> => {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
  if (!apiKey) {
    ctx.ui.notify(`OpenRouter matched the model, but Pi has no OpenRouter API key configured.`, "error");
    return undefined;
  }

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
      },
    ],
  });

  return ctx.modelRegistry.find("openrouter-live", model.id);
};

const resolveModel = async (
  pi: ExtensionAPI,
  ctx: CommandContext,
  query: string,
): Promise<Model<any> | undefined> => {
  const exactLocalMatch = findExactAvailableModel(ctx, query);
  if (exactLocalMatch) {
    ctx.ui.notify(`Pi-Bench matched "${query}" to ${formatModelLabel(exactLocalMatch)}.`, "info");
    return exactLocalMatch;
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
  const model = ctx.modelRegistry.find("openrouter", resolvedId);
  if (model) {
    ctx.ui.notify(`Pi-Bench matched "${query}" to OpenRouter model ${resolvedId}.`, "info");
    return model;
  }

  const liveModel = await registerLiveOpenRouterModel(pi, ctx, openRouterMatch.model);
  if (liveModel) {
    ctx.ui.notify(`Pi-Bench matched "${query}" to live OpenRouter model ${resolvedId}.`, "info");
    return liveModel;
  }

  const fuzzyLocalMatch = findFuzzyAvailableModel(ctx, query);
  if (fuzzyLocalMatch) {
    ctx.ui.notify(`Pi-Bench matched "${query}" to ${formatModelLabel(fuzzyLocalMatch)}.`, "info");
    return fuzzyLocalMatch;
  }

  return undefined;
};

export default function piBenchExtension(pi: ExtensionAPI) {
  pi.registerCommand("pibench", {
    description: "Run and inspect local Pi-Bench coding trials",
    getArgumentCompletions(prefix: string) {
      const options = [
        "run quick",
        "run quick openrouter/qwen/qwen3-coder",
        "run deepseek",
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
        clearActiveRun();
        ctx.ui.setStatus("pi-bench", `Pi-Bench complete ${result.score}/100`);
        ctx.ui.notify(formatRunResult(result), result.passed ? "info" : "warning");
        return;
      }

      ctx.ui.notify("Usage: /pibench run [suite] [model query] | doctor | history | suggest | status | score", "warning");
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
      clearActiveRun();
      ctx.abort();
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

  pi.on("model_select", async (event, ctx) => {
    const activeRun = getActiveRun();
    if (!activeRun) return;
    activeRun.modelLabel = `${event.model.provider}/${event.model.id}`;
    ctx.ui.setStatus("pi-bench", `Pi-Bench model ${activeRun.modelLabel}`);
  });
}
