import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchTask } from "../types.js";

type QuickTaskOptions = {
  workspace: string;
  seed: string;
};

type TaskFactory = (options: QuickTaskOptions) => Promise<BenchTask>;

const taskFactories: Record<string, TaskFactory> = {
  receipt: createReceiptTask,
  inventory: createInventoryTask,
  settings: createSettingsTask,
};

export const createQuickTask = async (options: QuickTaskOptions): Promise<BenchTask> => {
  const selected = process.env.PI_BENCH_TASK_KIND ?? selectTaskKind(options.seed);
  const factory = taskFactories[selected] ?? taskFactories.receipt;
  return factory(options);
};

const selectTaskKind = (seed: string) => {
  const keys = Object.keys(taskFactories);
  const hash = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return keys[hash % keys.length];
};

const prepareWorkspace = async (workspace: string) => {
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "test"), { recursive: true });
  const hiddenDir = path.join(workspace, "..", "hidden");
  await mkdir(hiddenDir, { recursive: true });
  return { hiddenDir };
};

const writePackageJson = async (workspace: string, seed: string, name: string) => {
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: `pibench-${name}-${seed}`,
    version: "0.0.0",
    type: "module",
    scripts: {
      test: "node --test test/visible.test.js",
    },
  }, null, 2));
};

async function createReceiptTask({ workspace, seed }: QuickTaskOptions): Promise<BenchTask> {
  const { hiddenDir } = await prepareWorkspace(workspace);
  await writePackageJson(workspace, seed, "receipt");

  await writeFile(path.join(workspace, "README.md"), `# Receipt Tools

This tiny package formats checkout receipts for a farmers market stand.
The public tests show the main failures. Hidden tests cover awkward user input
and rounding edge cases.
`);

  await writeFile(path.join(workspace, "src/receipt.js"), `export function slugifyProductName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(" ", "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function calculateLineTotalCents(item) {
  const quantity = item.quantity || 1;
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

  return {
    lines,
    subtotalCents: lines.reduce((sum, line) => sum + line.totalCents, 0),
  };
}
`);

  await writeFile(path.join(workspace, "test/visible.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { calculateLineTotalCents, slugifyProductName, summarizeReceipt } from "../src/receipt.js";

test("slugifies product names for receipt ids", () => {
  assert.equal(slugifyProductName("Honey Crisp Apple"), "honey-crisp-apple");
});

test("calculates line total with quantity and discount", () => {
  assert.equal(calculateLineTotalCents({
    name: "Jam",
    quantity: 3,
    unitPrice: 4.25,
    discountPercent: 10,
  }), 1148);
});

test("summarizes receipt subtotal", () => {
  const receipt = summarizeReceipt([
    { name: "Honey Crisp Apple", quantity: 2, unitPrice: 1.5 },
    { name: "Jam", quantity: 1, unitPrice: 4.25 },
  ]);
  assert.equal(receipt.subtotalCents, 725);
});
`);

  await writeFile(path.join(hiddenDir, "hidden.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { calculateLineTotalCents, slugifyProductName, summarizeReceipt } from "../workspace/src/receipt.js";

test("slugifies repeated whitespace and punctuation", () => {
  assert.equal(slugifyProductName("  Goat Cheese!!  "), "goat-cheese");
  assert.equal(slugifyProductName("Fresh   Basil & Mint"), "fresh-basil-mint");
});

test("keeps explicit zero quantity and zero discount meaningful", () => {
  assert.equal(calculateLineTotalCents({
    name: "Sample",
    quantity: 0,
    unitPrice: 9.99,
    discountPercent: 0,
  }), 0);
});

test("rounds after applying decimal unit price and discount", () => {
  assert.equal(calculateLineTotalCents({
    name: "Tomatoes",
    quantity: 3,
    unitPrice: 1.335,
    discountPercent: 12.5,
  }), 350);
});

test("summaries keep stable ids for awkward labels", () => {
  const receipt = summarizeReceipt([
    { name: "  Fresh   Basil & Mint ", quantity: 1, unitPrice: 2 },
  ]);
  assert.deepEqual(receipt.lines[0], {
    id: "fresh-basil-mint",
    label: "Fresh   Basil & Mint",
    totalCents: 200,
  });
});
`);

  return buildTask("Fix receipt formatting and totals", [
    "Fix the generated receipt-tools package.",
    "",
    "The visible tests are failing. Hidden tests check related edge cases, so implement the behavior generally rather than hard-coding the visible examples.",
    "",
    "Expected behavior:",
    "- product ids should be lowercase slugs with runs of non-alphanumeric characters collapsed to one hyphen",
    "- product ids should not have leading or trailing hyphens",
    "- explicit quantity: 0 should produce a zero total",
    "- totals should be calculated in cents after applying quantity and discount",
    "- receipt labels should be trimmed but preserve internal spacing",
  ]);
}

async function createInventoryTask({ workspace, seed }: QuickTaskOptions): Promise<BenchTask> {
  const { hiddenDir } = await prepareWorkspace(workspace);
  await writePackageJson(workspace, seed, "inventory");

  await writeFile(path.join(workspace, "README.md"), `# Inventory Tools

This package normalizes stock records for a small warehouse.
Visible tests cover common records. Hidden tests cover punctuation, missing
values, and low-stock boundary cases.
`);

  await writeFile(path.join(workspace, "src/inventory.js"), `export function normalizeSku(value) {
  return String(value).trim().toUpperCase().replace(" ", "-");
}

export function parseQuantity(value) {
  return Number(value) || 0;
}

export function summarizeInventory(records, lowStockThreshold = 5) {
  const items = records.map((record) => ({
    sku: normalizeSku(record.sku),
    quantity: parseQuantity(record.quantity),
  }));

  return {
    items,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    lowStockSkus: items.filter((item) => item.quantity < lowStockThreshold).map((item) => item.sku),
  };
}
`);

  await writeFile(path.join(workspace, "test/visible.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSku, parseQuantity, summarizeInventory } from "../src/inventory.js";

test("normalizes sku spacing", () => {
  assert.equal(normalizeSku(" abc 123 "), "ABC-123");
});

test("parses numeric quantity strings", () => {
  assert.equal(parseQuantity("7"), 7);
});

test("summarizes totals and low stock", () => {
  const summary = summarizeInventory([
    { sku: " abc 123 ", quantity: "7" },
    { sku: "milk", quantity: "2" },
  ]);
  assert.equal(summary.totalQuantity, 9);
  assert.deepEqual(summary.lowStockSkus, ["MILK"]);
});
`);

  await writeFile(path.join(hiddenDir, "hidden.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSku, parseQuantity, summarizeInventory } from "../workspace/src/inventory.js";

test("collapses punctuation and repeated separators in skus", () => {
  assert.equal(normalizeSku("  milk crate!! 42  "), "MILK-CRATE-42");
  assert.equal(normalizeSku("__cold__brew__"), "COLD-BREW");
});

test("missing and blank quantities become zero", () => {
  assert.equal(parseQuantity(""), 0);
  assert.equal(parseQuantity(null), 0);
});

test("negative quantities are clamped to zero", () => {
  assert.equal(parseQuantity("-4"), 0);
});

test("low stock includes values equal to the threshold", () => {
  const summary = summarizeInventory([
    { sku: "nuts", quantity: "5" },
    { sku: "dates", quantity: "6" },
  ], 5);
  assert.deepEqual(summary.lowStockSkus, ["NUTS"]);
});
`);

  return buildTask("Fix inventory normalization", [
    "Fix the generated inventory-tools package.",
    "",
    "Visible tests cover common inventory rows. Hidden tests check awkward sku punctuation, missing values, negative quantities, and threshold boundaries.",
    "",
    "Expected behavior:",
    "- skus should be uppercase slugs with runs of non-alphanumeric characters collapsed to one hyphen",
    "- skus should not have leading or trailing hyphens",
    "- missing, blank, or null quantities should become 0",
    "- negative quantities should be clamped to 0",
    "- low stock should include quantities less than or equal to the threshold",
  ]);
}

async function createSettingsTask({ workspace, seed }: QuickTaskOptions): Promise<BenchTask> {
  const { hiddenDir } = await prepareWorkspace(workspace);
  await writePackageJson(workspace, seed, "settings");

  await writeFile(path.join(workspace, "README.md"), `# Settings Tools

This package parses environment-style settings for a CLI.
Visible tests cover simple inputs. Hidden tests cover comments, duplicate keys,
quotes, and boolean coercion.
`);

  await writeFile(path.join(workspace, "src/settings.js"), `export function parseSettings(source) {
  const result = {};
  for (const line of String(source).split("\\n")) {
    if (!line.trim()) continue;
    const [key, value] = line.split("=");
    result[key.trim()] = value.trim();
  }
  return result;
}

export function getBooleanSetting(settings, key, fallback = false) {
  return settings[key] || fallback;
}
`);

  await writeFile(path.join(workspace, "test/visible.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { getBooleanSetting, parseSettings } from "../src/settings.js";

test("parses key value lines", () => {
  assert.deepEqual(parseSettings("PORT=3000\\nHOST=localhost"), {
    PORT: "3000",
    HOST: "localhost",
  });
});

test("trims keys and values", () => {
  assert.deepEqual(parseSettings(" NAME = pi-bench "), { NAME: "pi-bench" });
});

test("reads boolean true", () => {
  assert.equal(getBooleanSetting({ DEBUG: "true" }, "DEBUG"), true);
});
`);

  await writeFile(path.join(hiddenDir, "hidden.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { getBooleanSetting, parseSettings } from "../workspace/src/settings.js";

test("ignores comments and blank lines", () => {
  assert.deepEqual(parseSettings("\\n# comment\\nPORT=3000\\n"), { PORT: "3000" });
});

test("keeps equals signs inside values", () => {
  assert.deepEqual(parseSettings("TOKEN=a=b=c"), { TOKEN: "a=b=c" });
});

test("strips matching single and double quotes", () => {
  assert.deepEqual(parseSettings("A=\\"hello\\"\\nB='world'"), { A: "hello", B: "world" });
});

test("coerces common boolean strings and respects fallback", () => {
  assert.equal(getBooleanSetting({ A: "false" }, "A", true), false);
  assert.equal(getBooleanSetting({ B: "1" }, "B"), true);
  assert.equal(getBooleanSetting({}, "MISSING", true), true);
});
`);

  return buildTask("Fix settings parsing", [
    "Fix the generated settings-tools package.",
    "",
    "Visible tests cover simple configuration. Hidden tests check comments, duplicate separators, quoted values, and boolean coercion.",
    "",
    "Expected behavior:",
    "- parse KEY=value lines into an object",
    "- trim keys and values",
    "- ignore blank lines and lines starting with #",
    "- preserve equals signs inside values",
    "- strip matching single or double quotes around values",
    "- boolean settings should understand true, false, 1, 0, yes, and no",
  ]);
}

const buildTask = (title: string, prompt: string[]): BenchTask => ({
  title,
  visibleCommand: "npm test",
  hiddenCommand: "node --test ../hidden/hidden.test.js",
  prompt: prompt.join("\n"),
});
