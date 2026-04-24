import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BenchRunResult } from "./types.js";

const getBenchRoot = () => path.join(process.env.HOME || tmpdir(), ".pi", "agent", "pi-bench");
const historyPath = () => path.join(getBenchRoot(), "history.json");

export const loadHistory = async (): Promise<BenchRunResult[]> => {
  try {
    const raw = await readFile(historyPath(), "utf8");
    const parsed = JSON.parse(raw) as BenchRunResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveRunResult = async (result: BenchRunResult) => {
  const file = historyPath();
  await mkdir(path.dirname(file), { recursive: true });
  const history = await loadHistory();
  const previousAttempts = history.filter((entry) => entry.runId === result.runId);
  const attempt = previousAttempts.reduce((max, entry) => Math.max(max, entry.attempt ?? 1), 0) + 1;
  const latestResult = { ...result, attempt };
  const withoutPreviousAttempts = history.filter((entry) => entry.runId !== result.runId);
  withoutPreviousAttempts.unshift(latestResult);
  await writeFile(file, JSON.stringify(withoutPreviousAttempts.slice(0, 200), null, 2));
};
