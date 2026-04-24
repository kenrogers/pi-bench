import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchTask } from "../types.js";

type StandardTaskOptions = {
  workspace: string;
  seed: string;
};

const prepareWorkspace = async (workspace: string) => {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  const hiddenDir = path.join(workspace, "..", "hidden");
  await mkdir(hiddenDir, { recursive: true });
  return { hiddenDir };
};

const writePackageJson = async (workspace: string, seed: string) => {
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: `pibench-sprint-${seed}`,
    version: "0.0.0",
    type: "module",
    scripts: {
      test: "node --test test/visible.test.js",
    },
  }, null, 2));
};

export const createStandardTask = async ({ workspace, seed }: StandardTaskOptions): Promise<BenchTask> => {
  const { hiddenDir } = await prepareWorkspace(workspace);
  await writePackageJson(workspace, seed);

  await writeFile(path.join(workspace, "README.md"), `# Sprint Planner

This package parses lightweight issue lists and plans a sprint from them.
Visible tests cover the normal flow. Hidden tests cover malformed rows,
priority normalization, title separators, and planning edge cases.
`);

  await writeFile(path.join(workspace, "src/parser.js"), `export function parseIssueLine(line) {
  const [id, priority, estimate, title] = String(line).split("|");
  return {
    id: id.trim(),
    priority: priority.trim().toUpperCase(),
    estimate: Number(estimate),
    title: title.trim(),
  };
}

export function parseIssueList(source) {
  return String(source).split("\\n").filter(Boolean).map(parseIssueLine);
}
`);

  await writeFile(path.join(workspace, "src/planner.js"), `const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function planSprint(issues, capacity) {
  const selected = [];
  let totalEstimate = 0;

  for (const issue of issues) {
    if (totalEstimate + issue.estimate < capacity) {
      selected.push(issue);
      totalEstimate += issue.estimate;
    }
  }

  return {
    selected,
    totalEstimate,
    remainingCapacity: capacity - totalEstimate,
  };
}

export function summarizeByPriority(issues) {
  const counts = {};
  for (const issue of issues) {
    counts[issue.priority] = (counts[issue.priority] || 0) + 1;
  }
  return counts;
}
`);

  await writeFile(path.join(workspace, "src/index.js"), `export { parseIssueLine, parseIssueList } from "./parser.js";
export { planSprint, summarizeByPriority } from "./planner.js";
`);

  await writeFile(path.join(workspace, "test/visible.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { parseIssueLine, planSprint, summarizeByPriority } from "../src/index.js";

test("parses a pipe-delimited issue line", () => {
  assert.deepEqual(parseIssueLine("API-1 | p1 | 3 | Fix login"), {
    id: "API-1",
    priority: "P1",
    estimate: 3,
    title: "Fix login",
  });
});

test("plans higher priority work first within capacity", () => {
  const plan = planSprint([
    { id: "DOC-1", priority: "P3", estimate: 2, title: "Docs" },
    { id: "API-1", priority: "P1", estimate: 3, title: "Login" },
    { id: "BUG-1", priority: "P0", estimate: 2, title: "Crash" },
  ], 5);

  assert.deepEqual(plan.selected.map((issue) => issue.id), ["BUG-1", "API-1"]);
  assert.equal(plan.totalEstimate, 5);
  assert.equal(plan.remainingCapacity, 0);
});

test("includes work that exactly fills capacity", () => {
  const plan = planSprint([{ id: "ONE", priority: "P2", estimate: 5, title: "Ship" }], 5);
  assert.deepEqual(plan.selected.map((issue) => issue.id), ["ONE"]);
});

test("summaries include all priority buckets", () => {
  assert.deepEqual(summarizeByPriority([
    { priority: "P0" },
    { priority: "P2" },
    { priority: "P2" },
  ]), { P0: 1, P1: 0, P2: 2, P3: 0 });
});
`);

  await writeFile(path.join(hiddenDir, "hidden.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { parseIssueLine, parseIssueList, planSprint, summarizeByPriority } from "../workspace/src/index.js";

test("preserves pipes inside titles after the third separator", () => {
  assert.deepEqual(parseIssueLine("API-2 | P2 | 2 | Cache | session tokens"), {
    id: "API-2",
    priority: "P2",
    estimate: 2,
    title: "Cache | session tokens",
  });
});

test("ignores blank and comment lines in issue lists", () => {
  assert.deepEqual(parseIssueList("\\n# backlog\\n API-1 | P1 | 3 | Login \\n   \\n"), [
    { id: "API-1", priority: "P1", estimate: 3, title: "Login" },
  ]);
});

test("normalizes missing or unknown priorities to P3", () => {
  assert.equal(parseIssueLine("OPS-1 | urgent | 1 | Restart").priority, "P3");
  assert.equal(parseIssueLine("OPS-2 |  | 1 | Triage").priority, "P3");
});

test("clamps missing, invalid, and negative estimates to zero", () => {
  assert.equal(parseIssueLine("A | P1 | nope | Bad estimate").estimate, 0);
  assert.equal(parseIssueLine("B | P1 | -3 | Negative estimate").estimate, 0);
  assert.equal(parseIssueLine("C | P1 |  | Blank estimate").estimate, 0);
});

test("planning is stable within priority and does not mutate input order", () => {
  const issues = [
    { id: "LOW", priority: "P3", estimate: 1, title: "Low" },
    { id: "A", priority: "P1", estimate: 2, title: "A" },
    { id: "B", priority: "P1", estimate: 2, title: "B" },
  ];
  const plan = planSprint(issues, 4);
  assert.deepEqual(plan.selected.map((issue) => issue.id), ["A", "B"]);
  assert.deepEqual(issues.map((issue) => issue.id), ["LOW", "A", "B"]);
});

test("priority summaries normalize unknown buckets", () => {
  assert.deepEqual(summarizeByPriority([{ priority: "P0" }, { priority: "urgent" }]), {
    P0: 1,
    P1: 0,
    P2: 0,
    P3: 1,
  });
});
`);

  return {
    title: "Fix sprint planning behavior",
    visibleCommand: "npm test",
    hiddenCommand: "node --test ../hidden/hidden.test.js",
    prompt: [
      "Fix the generated sprint-planner package.",
      "",
      "Visible tests cover the normal planning flow. Hidden tests check malformed issue rows, priority normalization, title separators, and stable planning behavior.",
      "",
      "Expected behavior:",
      "- issue lines use the format ID | PRIORITY | ESTIMATE | TITLE",
      "- trim parsed fields",
      "- priorities should normalize to P0, P1, P2, or P3; unknown or missing priority becomes P3",
      "- estimates should be finite non-negative numbers; missing, invalid, or negative estimates become 0",
      "- titles should preserve internal spacing and any pipe characters after the third separator",
      "- issue lists should ignore blank lines and lines starting with #",
      "- sprint planning should sort by priority from P0 to P3 while preserving original order within the same priority",
      "- planning should select work while total estimate is less than or equal to capacity and should not mutate the input array",
      "- priority summaries should always include P0, P1, P2, and P3 counts",
    ].join("\n"),
  };
};
