/**
 * Build.
 *
 *   node scripts/build.mjs            -> dist/ (static site: index.html + app.js + assets)
 *   node scripts/build.mjs --single   -> dist/orangey.html as well (one self-contained file)
 *
 * Every path the page uses is relative and the service worker's scope is ".",
 * so dist/ works wherever it is served from: the root of a domain, a project
 * subpath, or a folder on a local server. There is no base path to configure
 * and so no way to get it wrong.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";
import { makeIcon } from "./icon.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const single = process.argv.includes("--single");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const css = ["src/ui/styles/tokens.css", "src/ui/styles/app.css"]
  .map((f) => readFileSync(join(root, f), "utf8"))
  .join("\n");

const js = bundle(join(root, "src/main.ts"), { root });

const page = ({ inlineAssets, scriptTag, styleTag, head = "" }) => `<!doctype html>
<!-- Orangey. The software is MIT-licensed; the Orangey character and artwork
     in this file are Copyright (c) 2026 Amogh Kinikar, all rights reserved.
     https://github.com/orangey-app/orangey/blob/main/LICENSE -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Orangey — randomizers for tabletop games</title>
<meta name="description" content="Dice, coins, numbers and weighted wheels for tabletop games. Works offline, keeps everything on your device.">
${head}
${styleTag}
</head>
<body>
<div id="app"></div>
<noscript>Orangey needs JavaScript: everything it does runs in your browser, and there is no server to do it instead.</noscript>
${scriptTag}
</body>
</html>
`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- static site -------------------------------------------------------------

writeFileSync(join(dist, "app.js"), js);
writeFileSync(join(dist, "app.css"), css);

const manifest = {
  name: "Orangey",
  short_name: "Orangey",
  description: "Randomizers for tabletop games",
  start_url: ".",
  scope: ".",
  display: "standalone",
  background_color: "#fff8ef",
  theme_color: "#f3a257",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    // The maskable copy is inset, so a phone cropping it to a circle never
    // clips the sides of his head.
    { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dist, "icon-192.png"), makeIcon(192));
writeFileSync(join(dist, "icon-512.png"), makeIcon(512));
writeFileSync(join(dist, "icon-512-maskable.png"), makeIcon(512, { inset: 0.78 }));

const sw = `// Orangey service worker: precache the shell so the app opens offline.
const CACHE = "orangey-v${version}";
const ASSETS = ["./", "./index.html", "./app.js", "./app.css", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
`;
writeFileSync(join(dist, "sw.js"), sw);

writeFileSync(
  join(dist, "index.html"),
  page({
    head: `<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<meta name="theme-color" content="#f3a257">`,
    styleTag: `<link rel="stylesheet" href="app.css">`,
    scriptTag: `<script type="module" src="app.js"></script>
<script>if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js", { scope: "." }).catch(() => {}));</script>`,
  }),
);

// --- single file -------------------------------------------------------------

if (single) {
  writeFileSync(
    join(dist, "orangey.html"),
    page({
      head: `<meta name="orangey-build" content="single">\n<link rel="icon" href="data:image/png;base64,${makeIcon(64).toString("base64")}">`,
      styleTag: `<style>\n${css}\n</style>`,
      scriptTag: `<script type="module">\n${js}\n</script>`,
    }),
  );
}

const size = (name) => `${(readFileSync(join(dist, name)).length / 1024).toFixed(1)} kB`;
console.log("built dist/ — relative paths, so it works at any address");
console.log(`  app.js       ${size("app.js")}`);
console.log(`  app.css      ${size("app.css")}`);
if (single) console.log(`  orangey.html ${size("orangey.html")}`);
