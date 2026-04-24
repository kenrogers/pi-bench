import type { BenchRun, BenchRunResult } from "./types.js";

export const describeRun = (run: BenchRun) => [
  `Pi-Bench run ${run.id}: ${run.task.title}`,
  "",
  `Workspace: ${run.workspace}`,
  `Suite: ${run.suite}`,
  `Model/setup label: ${run.modelLabel} / ${run.setupLabel}`,
  "",
  run.task.prompt,
  "",
  "This is a benchmark run. Keep narration short and spend the budget on tool use.",
  "Work only inside the workspace above. Do not inspect parent directories or unrelated Pi-Bench runs.",
  "Suggested path: read README.md, source files under src/, and tests under test/; edit the implementation; run the visible tests.",
  `Run visible tests with: cd ${shellQuote(run.workspace)} && ${run.task.visibleCommand}`,
  "When the visible tests pass and you believe the implementation is correct, call the pibench_submit tool.",
  "After pibench_submit returns, the benchmark is complete; do not write any follow-up analysis.",
].join("\n");

export const formatRunResult = (result: BenchRunResult) => [
  `Pi-Bench score: ${result.score}/100 ${result.passed ? "(passed)" : "(not passed)"}`,
  ...(result.process.providerErrors ? [`Run state: provider/API interruption observed`] : []),
  `Benchmark complete. Stop now; do not continue editing or reasoning about this run.`,
  `Model/setup: ${result.modelLabel} / ${result.setupLabel}`,
  `Suite: ${result.suite}`,
  `Attempt: ${result.attempt ?? 1}`,
  `Workspace: ${result.workspace}`,
  "",
  `Visible tests: ${formatTestSummary(result.visible)}`,
  `Hidden tests: ${formatTestSummary(result.hidden)}`,
  `Process: ${Math.round(result.process.score * 100)}% (${result.process.toolCalls} tool calls, ${result.process.testRuns} test runs)`,
  `Churn: ${result.churn.changedFiles} files, ${result.churn.changedLines} changed lines`,
  ...result.process.observations.map((line) => `- ${line}`),
].join("\n");

export const formatStatus = (run: BenchRun | undefined) => {
  if (!run) return "No active Pi-Bench run. Start one with /pibench run quick.";
  return [
    `Active Pi-Bench run: ${run.id}`,
    `Suite: ${run.suite}`,
    `Workspace: ${run.workspace}`,
    `Model/setup: ${run.modelLabel} / ${run.setupLabel}`,
  ].join("\n");
};

export const formatHistory = (runs: BenchRunResult[]) => {
  if (runs.length === 0) return "No Pi-Bench history yet. Start with /pibench run quick.";
  return runs.slice(0, 10).map((run) => [
    `${run.score}/100 ${run.passed ? "pass" : "fail"} ${run.suite}${(run.attempt ?? 1) > 1 ? ` attempt ${run.attempt}` : ""}`,
    `${run.modelLabel}`,
    `${new Date(run.finishedAt).toLocaleString()}`,
  ].join(" | ")).join("\n");
};

export const formatSuggestions = (runs: BenchRunResult[]) => {
  if (runs.length === 0) {
    return "Run a few Pi-Bench trials first. Suggestions get better once there is history.";
  }

  const latest = runs[0];
  const suggestions: string[] = [];

  if (!latest.hidden.passed && latest.visible.passed) {
    suggestions.push("Visible tests passed but hidden tests failed. Add stronger instructions to generalize from tests instead of fitting examples.");
  }
  if (latest.process.testRuns === 0) {
    suggestions.push("The agent did not run tests before submitting. Add a Pi instruction requiring a visible test run before completion.");
  }
  if (latest.process.readCalls === 0) {
    suggestions.push("The agent did not use the read tool. Encourage inspect-before-edit behavior in your Pi setup.");
  }
  if (latest.churn.changedLines > 60) {
    suggestions.push("Churn was high for this small task. Add guidance to prefer minimal, targeted patches.");
  }
  if (latest.process.errorResults > 2) {
    suggestions.push("Several tool calls failed. Consider tightening shell/path instructions or adding safer helper tools.");
  }
  if ((latest.process.providerErrors ?? 0) > 0) {
    suggestions.push("The latest run hit provider/API errors. Try a non-reasoning setting, a different OpenRouter route, or a fresh run before comparing scores.");
  }

  const byModel = new Map<string, BenchRunResult[]>();
  for (const run of runs) {
    byModel.set(run.modelLabel, [...(byModel.get(run.modelLabel) || []), run]);
  }
  const modelAverages = [...byModel.entries()].map(([model, modelRuns]) => ({
    model,
    average: modelRuns.reduce((sum, run) => sum + run.score, 0) / modelRuns.length,
    count: modelRuns.length,
  })).sort((a, b) => b.average - a.average);

  if (modelAverages.length > 1) {
    const best = modelAverages[0];
    suggestions.push(`Best historical model so far: ${best.model} at ${best.average.toFixed(1)} average over ${best.count} run(s).`);
  }

  return suggestions.length > 0 ? suggestions.map((item) => `- ${item}`).join("\n") : "No obvious improvement suggestions from the latest run. Nice.";
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const formatTestSummary = (result: BenchRunResult["visible"]) => {
  if (result.totalCount === undefined || result.passedCount === undefined || result.failedCount === undefined) {
    return result.passed ? "passed" : "failed";
  }
  return `${result.passed ? "passed" : "failed"} (${result.passedCount}/${result.totalCount})`;
};
