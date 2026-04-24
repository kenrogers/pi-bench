import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRun, scoreRun } from "../src/pibench/core.ts";
import { saveRunResult, loadHistory } from "../src/pibench/history.ts";
import { parseCompareArgs, patchDeepSeekReasoningContent } from "../src/extension.ts";
import type { BenchEvent } from "../src/pibench/types.ts";

let testChain = Promise.resolve();

const serialTest = (name: string, fn: () => Promise<void>) => {
  test(name, async () => {
    const next = testChain.then(fn);
    testChain = next.catch(() => undefined);
    return next;
  });
};

const withTempHome = async <T>(fn: () => Promise<T>, taskKind = "receipt"): Promise<T> => {
  const previousHome = process.env.HOME;
  const previousTaskKind = process.env.PI_BENCH_TASK_KIND;
  const home = await mkdtemp(path.join(tmpdir(), "pibench-test-"));
  process.env.HOME = home;
  process.env.PI_BENCH_TASK_KIND = taskKind;
  try {
    return await fn();
  } finally {
    process.env.HOME = previousHome;
    if (previousTaskKind === undefined) {
      delete process.env.PI_BENCH_TASK_KIND;
    } else {
      process.env.PI_BENCH_TASK_KIND = previousTaskKind;
    }
  }
};

const createTestRun = async (events: BenchEvent[] = []) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pibench-cwd-"));
  const run = await createRun({
    suite: "quick",
    cwd,
    modelLabel: "test/model",
    setupLabel: "test-setup",
  });
  run.events.push(...events);
  return run;
};

const realisticEvents = (): BenchEvent[] => [
  { type: "tool_call", at: 1, toolName: "read", input: { path: "README.md" } },
  { type: "tool_result", at: 2, toolName: "read", isError: false },
  { type: "tool_call", at: 3, toolName: "read", input: { path: "src/receipt.js" } },
  { type: "tool_result", at: 4, toolName: "read", isError: false },
  { type: "tool_call", at: 5, toolName: "edit", input: { path: "src/receipt.js" } },
  { type: "tool_result", at: 6, toolName: "edit", isError: false },
  { type: "tool_call", at: 7, toolName: "bash", input: { command: "npm test" } },
  { type: "tool_result", at: 8, toolName: "bash", isError: false },
  { type: "tool_call", at: 9, toolName: "pibench_submit", input: {} },
];

const writeReceipt = async (workspace: string, source: string) => {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "receipt.js"), source);
};

serialTest("untouched scaffold gets a low score with visible and hidden pass ratios", async () => {
  await withTempHome(async () => {
    const run = await createTestRun();
    const result = await scoreRun(run.id);

    assert.equal(result.visible.passed, false);
    assert.equal(result.visible.passedCount, 2);
    assert.equal(result.visible.totalCount, 3);
    assert.equal(result.hidden.passed, false);
    assert.equal(result.hidden.passedCount, 0);
    assert.equal(result.hidden.totalCount, 4);
    assert.ok(result.score >= 20 && result.score <= 30);
  });
});

serialTest("mostly correct agent work scores high but below full pass", async () => {
  await withTempHome(async () => {
    const run = await createTestRun(realisticEvents());
    await writeReceipt(run.workspace, `export function slugifyProductName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function calculateLineTotalCents(item) {
  const quantity = item.quantity != null ? item.quantity : 1;
  const unitCents = Math.round(item.unitPrice * 100);
  const discount = item.discountPercent || 0;
  return Math.round(quantity * unitCents * (1 - discount / 100));
}

export function summarizeReceipt(items) {
  const lines = items.map((item) => ({
    id: slugifyProductName(item.name),
    label: item.name.trim(),
    totalCents: calculateLineTotalCents(item),
  }));
  return { lines, subtotalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) };
}
`);

    const result = await scoreRun(run.id);
    assert.equal(result.visible.passed, true);
    assert.equal(result.hidden.passed, false);
    assert.equal(result.hidden.passedCount, 3);
    assert.equal(result.hidden.totalCount, 4);
    assert.ok(result.score >= 75 && result.score < 90);
  });
});

serialTest("complete fix with realistic process lands near the top", async () => {
  await withTempHome(async () => {
    const run = await createTestRun(realisticEvents());
    await writeReceipt(run.workspace, `export function slugifyProductName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function calculateLineTotalCents(item) {
  const quantity = item.quantity ?? 1;
  const discount = item.discountPercent ?? 0;
  return Math.round(quantity * item.unitPrice * (1 - discount / 100) * 100);
}

export function summarizeReceipt(items) {
  const lines = items.map((item) => ({
    id: slugifyProductName(item.name),
    label: item.name.trim(),
    totalCents: calculateLineTotalCents(item),
  }));
  return { lines, subtotalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) };
}
`);

    const result = await scoreRun(run.id);
    assert.equal(result.visible.passed, true);
    assert.equal(result.hidden.passed, true);
    assert.ok(result.score >= 90);
  });
});

serialTest("provider errors reduce the process score for interrupted runs", async () => {
  await withTempHome(async () => {
    const run = await createTestRun([
      ...realisticEvents().filter((event) => event.toolName !== "pibench_submit"),
      { type: "provider_response", at: 10, status: 400, isError: true },
    ]);
    await writeReceipt(run.workspace, `export function slugifyProductName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function calculateLineTotalCents(item) {
  const quantity = item.quantity ?? 1;
  const discount = item.discountPercent ?? 0;
  return Math.round(quantity * item.unitPrice * (1 - discount / 100) * 100);
}

export function summarizeReceipt(items) {
  const lines = items.map((item) => ({
    id: slugifyProductName(item.name),
    label: item.name.trim(),
    totalCents: calculateLineTotalCents(item),
  }));
  return { lines, subtotalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) };
}
`);

    const result = await scoreRun(run.id);
    assert.equal(result.hidden.passed, true);
    assert.equal(result.process.providerErrors, 1);
    assert.ok(result.process.observations.includes("provider errors interrupted the run"));
    assert.ok(result.score <= 90);
  });
});

serialTest("quick suite task catalog generates runnable visible and hidden checks", async () => {
  for (const taskKind of ["receipt", "inventory", "settings"]) {
    await withTempHome(async () => {
      const run = await createTestRun();
      const result = await scoreRun(run.id);
      assert.equal(result.visible.totalCount, 3);
      assert.equal(result.hidden.totalCount, 4);
    }, taskKind);
  }
});

serialTest("saving the same run twice keeps one history row and increments attempts", async () => {
  await withTempHome(async () => {
    const run = await createTestRun();
    const first = await scoreRun(run.id);
    await saveRunResult({ ...first, score: first.score + 1 });

    const history = await loadHistory();
    assert.equal(history.filter((entry) => entry.runId === run.id).length, 1);
    assert.equal(history[0]?.attempt, 2);
  });
});

serialTest("DeepSeek OpenRouter payloads preserve reasoning_content for tool turns", async () => {
  const payload = {
    model: "deepseek/deepseek-v4-flash",
    messages: [
      { role: "user", content: "Fix the bug" },
      {
        role: "assistant",
        content: "",
        reasoning: "I need to inspect the files first.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "..." },
    ],
  };

  const patched = patchDeepSeekReasoningContent(payload) as { messages: Array<Record<string, unknown>> };
  assert.notEqual(patched, undefined);
  assert.equal(patched.messages[1]?.reasoning_content, "I need to inspect the files first.");
});

serialTest("non-DeepSeek payloads are left alone by the reasoning_content shim", async () => {
  const payload = {
    model: "anthropic/claude-sonnet-4.5",
    messages: [{ role: "assistant", content: "", reasoning: "private reasoning" }],
  };

  assert.equal(patchDeepSeekReasoningContent(payload), undefined);
});

serialTest("compare arguments split multi-word model queries", async () => {
  assert.deepEqual(parseCompareArgs("quick deepseek 4 flash vs qwen/qwen3-coder vs kimi k2"), {
    suite: "quick",
    modelQueries: ["deepseek 4 flash", "qwen/qwen3-coder", "kimi k2"],
  });
});

serialTest("compare arguments support comma and pipe separators", async () => {
  assert.deepEqual(parseCompareArgs("deepseek 4 flash, qwen/qwen3-coder | kimi k2"), {
    suite: "quick",
    modelQueries: ["deepseek 4 flash", "qwen/qwen3-coder", "kimi k2"],
  });
});
