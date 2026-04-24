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

const openRouterModelId = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
};

const formatModelLabel = (model: Pick<Model<any>, "provider" | "id">): string => `${model.provider}/${model.id}`;

const isOpenRouterModel = (model: Model<any>): boolean => {
  return model.provider === "openrouter" || model.provider === "openrouter-live" || model.baseUrl.includes("openrouter.ai");
};

const findExactOpenRouterModel = (ctx: CommandContext, query: string): Model<any> | undefined => {
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

const registerLiveOpenRouterModel = async (
  pi: ExtensionAPI,
  ctx: CommandContext,
  model: OpenRouterModelSummary,
): Promise<Model<any> | undefined> => {
  const apiKey = await ensureOpenRouterApiKey(ctx);
  if (!apiKey) {
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

const ensureOpenRouterApiKey = async (ctx: CommandContext): Promise<string | undefined> => {
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

const promptForOpenRouterModelQuery = async (ctx: CommandContext): Promise<string | undefined> => {
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
  ctx: CommandContext,
  modelQuery: string | undefined,
): Promise<Model<any> | undefined> => {
  if (modelQuery) {
    return resolveOpenRouterModel(pi, ctx, modelQuery);
  }

  if (ctx.model && isOpenRouterModel(ctx.model)) {
    ctx.ui.notify(`Pi-Bench will use the current OpenRouter model ${formatModelLabel(ctx.model)}.`, "info");
    return ctx.model;
  }

  const openRouterApiKey = await ensureOpenRouterApiKey(ctx);
  if (!openRouterApiKey) return undefined;

  const promptedQuery = await promptForOpenRouterModelQuery(ctx);
  if (!promptedQuery) return undefined;

  return resolveOpenRouterModel(pi, ctx, promptedQuery);
};

const resolveOpenRouterModel = async (
  pi: ExtensionAPI,
  ctx: CommandContext,
  query: string,
): Promise<Model<any> | undefined> => {
  const exactLocalMatch = findExactOpenRouterModel(ctx, query);
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
