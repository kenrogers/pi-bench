import type { BenchEvent, ProcessScore } from "./types.js";

export const scoreProcess = (events: BenchEvent[]): ProcessScore => {
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const bashCalls = toolCalls.filter((event) => event.toolName === "bash");
  const readCalls = toolCalls.filter((event) => event.toolName === "read");
  const editCalls = toolCalls.filter((event) => event.toolName === "edit" || event.toolName === "write");
  const submitCalls = toolCalls.filter((event) => event.toolName === "pibench_submit");
  const errorResults = events.filter((event) => event.type === "tool_result" && event.isError).length;
  const providerErrors = events.filter((event) => event.type === "provider_response" && (event.status ?? 0) >= 400).length;
  const testRuns = bashCalls.filter((event) => {
    const command = getCommand(event.input);
    return /\b(npm test|npm run test|node --test|pnpm test|yarn test)\b/.test(command);
  }).length;
  const firstEditAt = editCalls[0]?.at ?? Number.POSITIVE_INFINITY;
  const firstSubmitAt = submitCalls[0]?.at ?? Number.POSITIVE_INFINITY;
  const readBeforeEdit = readCalls.some((event) => event.at <= firstEditAt);
  const testBeforeSubmit = bashCalls.some((event) => event.at <= firstSubmitAt && /\b(npm test|npm run test|node --test|pnpm test|yarn test)\b/.test(getCommand(event.input)));
  const toolCallsAfterSubmit = Number.isFinite(firstSubmitAt)
    ? toolCalls.filter((event) => event.at > firstSubmitAt).length
    : 0;

  const observations: string[] = [];
  let score = 0.2;

  if (readBeforeEdit) {
    score += 0.2;
    observations.push("inspected files before editing");
  } else if (readCalls.length > 0) {
    score += 0.1;
    observations.push("inspected files, but not before the first edit");
  } else {
    observations.push("no read tool usage was observed");
  }

  if (testRuns > 0) {
    score += 0.25;
    observations.push("ran tests during the task");
  } else {
    observations.push("no test command was observed before scoring");
  }

  if (editCalls.length > 0) {
    score += 0.15;
    observations.push("made explicit file edits");
  }

  if (submitCalls.length > 0 && testBeforeSubmit) {
    score += 0.15;
    observations.push("submitted after running tests");
  } else if (submitCalls.length > 0) {
    score += 0.05;
    observations.push("submitted before an observed test run");
  }

  if (errorResults > 2) {
    score -= 0.1;
    observations.push("several tool calls failed");
  }

  if (providerErrors > 0) {
    score -= 0.45;
    observations.push("provider errors interrupted the run");
  }

  if (toolCalls.length > 40) {
    score -= 0.1;
    observations.push("high tool-call count suggests possible thrashing");
  } else if (toolCalls.length <= 8 && submitCalls.length > 0) {
    score += 0.03;
    observations.push("completed with a compact tool trace");
  } else if (toolCalls.length <= 12 && submitCalls.length > 0) {
    score += 0.01;
    observations.push("completed with a moderate tool trace");
  }

  if (toolCallsAfterSubmit > 0) {
    score -= 0.1;
    observations.push("continued using tools after submitting the benchmark");
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    toolCalls: toolCalls.length,
    bashCalls: bashCalls.length,
    readCalls: readCalls.length,
    editCalls: editCalls.length,
    testRuns,
    submitCalls: submitCalls.length,
    toolCallsAfterSubmit,
    providerErrors,
    errorResults,
    observations,
  };
};

const getCommand = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const maybeCommand = (input as { command?: unknown }).command;
  return typeof maybeCommand === "string" ? maybeCommand : "";
};
