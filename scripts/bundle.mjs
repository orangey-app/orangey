/**
 * A small, strict ES-module bundler: strips TypeScript types with Node's own
 * stripper and concatenates the modules into one script in dependency order.
 *
 * The build has no dependencies, so this does only what the project needs. It is
 * strict rather than clever: only relative imports, no default exports, no
 * re-exports, and every top-level name must be unique, since all modules end up
 * in one shared scope. Breaking a rule is a build error, not a mystery at runtime.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const IMPORT_RE = /^[ \t]*import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?;?[ \t]*$/gm;
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm;

/** The bundled source, for `build.mjs`. */
export function bundle(entryPath, options = {}) {
  return bundleProgram(entryPath, options).code;
}

/**
 * The bundled source plus the files that went into it, in load order.
 * `check.mjs` needs the file list; `build.mjs` only wants the string.
 */
export function bundleProgram(entryPath, { root = process.cwd() } = {}) {
  const entry = resolve(entryPath);
  const modules = new Map();
  const order = [];
  const owners = new Map();

  function load(file) {
    if (modules.has(file)) return;
    modules.set(file, null); // placeholder, marks "in progress"

    // LF whatever the checkout has, so the same source always builds the same bytes.
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    let stripped;
    try {
      stripped = stripTypeScriptTypes(source, { mode: "strip" });
    } catch (e) {
      throw new Error(`${relative(root, file)}: ${e.message}`);
    }

    const deps = [];
    for (const match of stripped.matchAll(IMPORT_RE)) {
      const clause = match[1] ?? "";
      const spec = match[2];
      // In the shared scope an alias would silently vanish.
      if (/\bas\b/.test(clause) && !/\*\s+as\b/.test(clause)) {
        throw new Error(`${relative(root, file)}: renaming imports is not supported (${clause.trim()})`);
      }
      if (/\*\s+as\b/.test(clause)) {
        throw new Error(`${relative(root, file)}: namespace imports are not supported (${clause.trim()})`);
      }
      if (!spec.startsWith(".")) throw new Error(`${relative(root, file)}: only relative imports are supported (${spec})`);
      deps.push(resolve(dirname(file), spec));
    }
    for (const match of stripped.matchAll(EXPORT_LIST_RE)) {
      if (/from/.test(match[0])) throw new Error(`${relative(root, file)}: re-exports are not supported`);
    }
    if (/^\s*export\s+default\b/m.test(stripped)) {
      throw new Error(`${relative(root, file)}: default exports are not supported`);
    }

    for (const dep of deps) load(dep);

    const body = stripped.replace(IMPORT_RE, "").replace(EXPORT_LIST_RE, "").replace(/^[ \t]*export\s+/gm, "");

    for (const match of body.matchAll(DECL_RE)) {
      const name = match[2];
      const previous = owners.get(name);
      if (previous && previous !== file) {
        throw new Error(
          `duplicate top-level name "${name}" in ${relative(root, file)} and ${relative(root, previous)} — ` +
            `the bundle puts every module in one scope, so names must be unique`,
        );
      }
      owners.set(name, file);
    }

    modules.set(file, body);
    order.push(file);
  }

  load(entry);

  // Forward slashes on every platform: these headers are part of the committed
  // orangey.html, which must not depend on the OS that built it.
  const label = (file) => relative(root, file).split(sep).join("/");
  const code = order
    .map((file) => `\n// ---- ${label(file)} ${"-".repeat(Math.max(0, 60 - label(file).length))}\n${modules.get(file).trim()}\n`)
    .join("");
  return { code, files: order.slice() };
}
