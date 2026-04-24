import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createQuickTask } from "./tasks/quick.js";
import { createStandardTask } from "./tasks/standard.js";
import { loadHistory, saveRunResult } from "./history.js";
import { scoreProcess } from "./process-score.js";
import type { BenchRun, BenchRunResult, CreateRunOptions, FileSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

let activeRun: BenchRun | undefined;
const runs = new Map<string, BenchRun>();

export const getActiveRun = () => activeRun;
export const setActiveRun = (id: string) => {
  activeRun = runs.get(id);
};
export const clearActiveRun = () => {
  activeRun = undefined;
};

export const recordRunEvent = async (event: BenchRun["events"][number]) => {
  const run = activeRun;
  if (!run) return;
  run.events.push(event);
  await saveRunManifest(run);
};

export const createRun = async (options: CreateRunOptions): Promise<BenchRun> => {
  const id = buildRunId();
  const seed = options.seed ?? id;
  const root = path.join(getBenchRoot(), "runs", id);
  const workspace = path.join(root, "workspace");

  if (options.suite !== "quick" && options.suite !== "standard") {
    throw new Error(`Unknown Pi-Bench suite: ${options.suite}`);
  }

  const task = options.suite === "standard"
    ? await createStandardTask({ workspace, seed })
    : await createQuickTask({ workspace, seed });
  const initialSnapshot = await snapshotFiles(workspace);

  const run: BenchRun = {
    id,
    suite: options.suite,
    cwd: options.cwd,
    root,
    workspace,
    task,
    modelLabel: options.modelLabel,
    setupLabel: options.setupLabel,
    startedAt: new Date().toISOString(),
    events: [],
    initialSnapshot,
  };

  runs.set(run.id, run);
  activeRun = run;
  await saveRunManifest(run);
  return run;
};

export const scoreRun = async (runId: string, notes?: string): Promise<BenchRunResult> => {
  const run = runs.get(runId) ?? await loadRunManifest(runId);
  if (!run) {
    throw new Error(`Pi-Bench run ${runId} is not loaded in this session.`);
  }
  runs.set(run.id, run);

  const visible = await runNodeTests(run.workspace, ["test/visible.test.js"]);
  const hidden = await runNodeTests(run.workspace, [path.join(run.root, "hidden", "hidden.test.js")]);
  const finalSnapshot = await snapshotFiles(run.workspace);
  const churn = calculateChurn(run.initialSnapshot, finalSnapshot);
  const process = scoreProcess(run.events);

  const visibleRatio = testPassRatio(visible);
  const hiddenRatio = testPassRatio(hidden);
  const correctness = Math.round(visibleRatio * 25 + hiddenRatio * 55);
  const processPoints = Math.round(process.score * 15);
  const efficiencyPoints = Math.max(0, 5 - Math.min(5, Math.floor(churn.changedLines / 15)));
  const score = Math.max(0, Math.min(100, correctness + processPoints + efficiencyPoints));

  const result: BenchRunResult = {
    runId: run.id,
    suite: run.suite,
    modelLabel: run.modelLabel,
    setupLabel: run.setupLabel,
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    workspace: run.workspace,
    score,
    passed: hidden.passed,
    visible,
    hidden,
    process,
    churn,
    notes,
  };

  await saveRunResult(result);
  return result;
};

export const listRuns = loadHistory;

export const getBenchRoot = () => path.join(process.env.HOME || tmpdir(), ".pi", "agent", "pi-bench");

const buildRunId = () => {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
};

const runManifestPath = (runId: string) => path.join(getBenchRoot(), "runs", runId, "run.json");

const saveRunManifest = async (run: BenchRun) => {
  await mkdir(run.root, { recursive: true });
  await writeFile(runManifestPath(run.id), JSON.stringify(run, null, 2));
};

const loadRunManifest = async (runId: string): Promise<BenchRun | undefined> => {
  try {
    const raw = await readFile(runManifestPath(runId), "utf8");
    return JSON.parse(raw) as BenchRun;
  } catch {
    return undefined;
  }
};

const runNodeTests = async (cwd: string, files: string[]) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = await execFileAsync(process.execPath, ["--test", ...files], {
      cwd,
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      passed: true,
      exitCode: 0,
      output,
      ...parseNodeTestCounts(output, true),
    };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trim();
    return {
      passed: false,
      exitCode: typeof err.code === "number" ? err.code : 1,
      output,
      ...parseNodeTestCounts(output, false),
    };
  }
};

const parseNodeTestCounts = (output: string, passed: boolean) => {
  const numberAfter = (label: string) => {
    const match = output.match(new RegExp(`${label}\\s+(\\d+)`));
    return match ? Number(match[1]) : undefined;
  };
  const totalCount = numberAfter("tests");
  const passedCount = numberAfter("pass");
  const failedCount = numberAfter("fail");
  if (totalCount === undefined || passedCount === undefined || failedCount === undefined) {
    return {
      totalCount: 1,
      passedCount: passed ? 1 : 0,
      failedCount: passed ? 0 : 1,
    };
  }
  return { totalCount, passedCount, failedCount };
};

const testPassRatio = (result: { passed: boolean; totalCount?: number; passedCount?: number }) => {
  const total = result.totalCount ?? 1;
  const passed = result.passedCount ?? (result.passed ? total : 0);
  return total <= 0 ? (result.passed ? 1 : 0) : Math.max(0, Math.min(1, passed / total));
};

const snapshotFiles = async (root: string): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  const walk = async (dir: string) => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const fullPath = path.join(dir, entry);
      const rel = path.relative(root, fullPath);
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        await walk(fullPath);
      } else if (info.isFile()) {
        snapshot[rel] = await readFile(fullPath, "utf8");
      }
    }
  };
  await walk(root);
  return snapshot;
};

const calculateChurn = (before: FileSnapshot, after: FileSnapshot) => {
  let changedFiles = 0;
  let changedLines = 0;
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const file of files) {
    if (before[file] === after[file]) continue;
    changedFiles += 1;
    const beforeLines = (before[file] ?? "").split("\n");
    const afterLines = (after[file] ?? "").split("\n");
    changedLines += Math.abs(afterLines.length - beforeLines.length);
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i += 1) {
      if (beforeLines[i] !== afterLines[i]) changedLines += 1;
    }
  }
  return { changedFiles, changedLines };
};
