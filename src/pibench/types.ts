export type BenchSuite = "quick";

export type CreateRunOptions = {
  suite: string;
  cwd: string;
  modelLabel: string;
  setupLabel: string;
};

export type BenchTask = {
  title: string;
  prompt: string;
  visibleCommand: string;
  hiddenCommand: string;
};

export type FileSnapshot = Record<string, string>;

export type BenchEvent = {
  type: "tool_call" | "tool_result" | "provider_response";
  at: number;
  toolName?: string;
  input?: unknown;
  isError?: boolean;
  status?: number;
};

export type BenchRun = {
  id: string;
  suite: string;
  cwd: string;
  root: string;
  workspace: string;
  task: BenchTask;
  modelLabel: string;
  setupLabel: string;
  startedAt: string;
  events: BenchEvent[];
  initialSnapshot: FileSnapshot;
};

export type TestResult = {
  passed: boolean;
  exitCode: number;
  output: string;
  totalCount?: number;
  passedCount?: number;
  failedCount?: number;
};

export type ProcessScore = {
  score: number;
  toolCalls: number;
  bashCalls: number;
  readCalls: number;
  editCalls: number;
  testRuns: number;
  submitCalls?: number;
  toolCallsAfterSubmit?: number;
  providerErrors?: number;
  errorResults: number;
  observations: string[];
};

export type BenchRunResult = {
  runId: string;
  attempt?: number;
  suite: string;
  modelLabel: string;
  setupLabel: string;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  score: number;
  passed: boolean;
  visible: TestResult;
  hidden: TestResult;
  process: ProcessScore;
  churn: {
    changedFiles: number;
    changedLines: number;
  };
  notes?: string;
};
