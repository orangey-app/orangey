/**
 * Project checks, run as `npm run check`.
 *
 * Node has no type checker built in, so this does what it can without one:
 * every module must strip and bundle cleanly (which catches syntax errors,
 * unsupported TypeScript, duplicate top-level names, aliased imports and
 * missing files), the palette must pass its own curation rules, and no
 * animation timing may be hard-coded outside the Feel module.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleProgram } from "./bundle.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// 1. Everything bundles.
let program = null;
try {
  program = bundleProgram(join(root, "src/main.ts"), { root });
} catch (e) {
  problems.push(`bundle: ${e.message}`);
}

// 2. Every source file is reachable from the entry point or from the tests.
//
// The bundler's own file list is not enough on its own: Node's type stripper
// erases `import type` before the imports are read, so a module that holds
// only types never joins the bundle even though deleting it would break the
// type check. So the reachable set is the bundled files plus a walk over the
// raw text, which sees the type-only edges too, started from the entry point
// and from every unit test.
const sources = walk(join(root, "src"));
if (program) {
  const SPECIFIER = /\bfrom\s*["'](\.[^"']+)["']/g;
  const reachable = new Set(program.files);
  const seen = new Set();

  function reach(file) {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    if (file.endsWith(".ts")) reachable.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) reach(resolve(dirname(file), match[1]));
  }

  reach(join(root, "src/main.ts"));
  for (const test of walk(join(root, "tests/unit"))) reach(test);

  for (const file of sources) {
    if (reachable.has(file)) continue;
    problems.push(`${relative(root, file)}: nothing reaches this file — not from src/main.ts, not from a test`);
  }
}

// 3. Animation timings live only in feel.ts.
const TIMING = /(\d+)\s*ms/;
for (const file of sources) {
  const rel = relative(root, file);
  if (rel.endsWith("ui/feel.ts")) continue;
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (!TIMING.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/feel|duration|tumble|coin|debounce|timeout|delay/i.test(line)) return;
    problems.push(`${rel}:${i + 1}: hard-coded timing outside feel.ts — ${line.trim()}`);
  });
}

// 4. The palette passes its own curation rules.
const { curate } = await import(join(root, "src/ui/styles/palette.ts"));
const { problems: paletteProblems } = curate();
for (const problem of paletteProblems) problems.push(`palette: ${problem}`);

// 5. No stray focus on production debug hooks.
const main = readFileSync(join(root, "src/main.ts"), "utf8");
if (!main.includes('URLSearchParams(location.search).has("debug")')) {
  problems.push("src/main.ts: the debug hook must stay behind ?debug");
}

if (problems.length) {
  console.error(`check failed with ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check passed (${sources.length} source files)`);
