/**
 * Project checks, run as `npm run check`.
 *
 * Node has no type checker built in, so this checks what it can without one:
 * every module must strip and bundle cleanly under the bundler's rules, every
 * source file must be reachable, no animation timing may be hard-coded
 * outside feel.ts, and the folders without a DOM never import from src/ui.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
// The bundle's own file list misses modules that hold only types, because
// Node's type stripper erases `import type` first; so this also walks the raw
// import text from the entry point and from every unit test.
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
  // Forward slashes: with Windows backslashes this one exemption would never match.
  if (rel.split(sep).join("/").endsWith("ui/feel.ts")) continue;
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (!TIMING.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (/feel|duration|tumble|coin|debounce|timeout|delay/i.test(line)) return;
    problems.push(`${rel}:${i + 1}: hard-coded timing outside feel.ts — ${line.trim()}`);
  });
}

// 4. The folders without a DOM never import from src/ui. ARCHITECTURE.md
// promises it, the unit suite depends on it, and Sekwe copies these four
// folders and nothing else. One exception, named: the settings file checks a
// loaded file against the app's own limits, and those are timings, which live
// only in ui/feel.ts (rule 3). Sekwe leaves that file out of its copy.
const NO_UI = ["core", "model", "import", "storage"];
const MAY_IMPORT_UI = new Set(["src/model/settings-file.ts"]);
for (const file of sources) {
  const rel = relative(root, file).split(sep).join("/");
  if (!NO_UI.some((folder) => rel.startsWith(`src/${folder}/`)) || MAY_IMPORT_UI.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)) {
    const target = relative(root, resolve(dirname(file), match[1])).split(sep).join("/");
    if (target.startsWith("src/ui/")) problems.push(`${rel}: imports ${match[1]} — this folder must not depend on src/ui`);
  }
}

// 5. The debug hook stays behind ?debug.
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
