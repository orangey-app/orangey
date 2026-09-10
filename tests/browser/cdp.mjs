/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Playwright could not be installed in the build sandbox, but Chromium is
 * present and Node has a WebSocket, so the browser tests drive it directly.
 * This is only as much of CDP as the tests use: navigate, evaluate, click,
 * type, and collect console errors.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".csv": "text/csv",
};

/** Serve a directory over http, so the page gets a real origin (OPFS, IndexedDB). */
export async function serve(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const body = await readFile(join(dir, path));
      const headers = {
        "content-type": MIME[extname(path)] ?? "application/octet-stream",
        "content-length": String(body.length),
      };
      // Headers only for HEAD, with the length spelled out rather than left
      // to the runtime to suppress.
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { "content-length": "9" });
      res.end(req.method === "HEAD" ? undefined : "not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    /**
     * `close` on its own waits for every keep-alive connection to end, which
     * a browser that is still running may not do promptly. Dropping the
     * connections first makes closing a server mid-suite predictable.
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

export async function launch({ profileDir } = {}) {
  const userDataDir = profileDir ?? mkdtempSync(join(tmpdir(), "orangey-"));
  const child = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-sandbox",
    "--no-proxy-server",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-default-apps",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    "--window-size=1280,900",
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "" } });

  const endpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`chrome did not start:\n${buffer}`)), 20000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`chrome exited (${code}):\n${buffer}`)));
  });

  const httpBase = endpoint.replace(/^ws:\/\//, "http://").replace(/\/devtools\/browser\/.*$/, "");

  return {
    async newPage() {
      const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
      const target = await res.json();
      return connectPage(target.webSocketDebuggerUrl);
    },
    async close() {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      if (!profileDir) {
        try {
          rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          /* the profile is temporary; leaving it behind is harmless */
        }
      }
    },
  };
}

async function connectPage(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  const waiters = [];
  const consoleErrors = [];
  const requests = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
    }
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    for (const [index, waiter] of [...waiters.entries()].reverse()) {
      if (waiter.method === message.method) {
        waiters.splice(index, 1);
        waiter.resolve(message.params);
      }
    }
  });

  /**
   * Every call is capped. A protocol call that never comes back — a page
   * promise that never settles, a renderer that has wedged — used to hang the
   * whole suite silently, which on a CI runner means a job that sits there
   * until the six-hour limit rather than a failure anyone can read.
   */
  const CALL_TIMEOUT_MS = 30000;
  const send = (method, params = {}, timeout = CALL_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not come back within ${timeout / 1000}s`));
      }, timeout);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const waitFor = (method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${method}`));
        }
      }, timeout);
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  const page = {
    send,
    waitFor,
    consoleErrors,
    requests,
    async goto(url) {
      // Always go via about:blank: navigating to a URL that differs only in
      // its hash does not fire a load event, and the tests reload constantly.
      await send("Page.navigate", { url: "about:blank" });
      await new Promise((r) => setTimeout(r, 30));
      const loaded = waitFor("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
      await page.waitForFunction("document.querySelector('#app') && document.querySelector('#app').children.length > 0");
    },
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    async waitForFunction(expression, timeout = 10000) {
      const started = Date.now();
      for (;;) {
        const ok = await page.evaluate(`return Boolean(${expression});`).catch(() => false);
        if (ok) return true;
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for: ${expression}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async click(selector) {
      await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("no element matching " + ${JSON.stringify(JSON.stringify(selector))});
        el.click();
      `);
    },
    async type(selector, value) {
      await page.evaluate(`
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("no element matching " + ${JSON.stringify(JSON.stringify(selector))});
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      `);
    },
    async key(key, opts = {}) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, ...opts });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, ...opts });
    },
    /** Wipe OPFS, IndexedDB and the rest for an origin, so tests start clean. */
    async clearStorage(origin) {
      await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    },
    async setOffline(offline) {
      await send("Network.emulateNetworkConditions", {
        offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    },
    async emulateReducedMotion(reduce) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }],
      });
    },
    async setViewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    },
    async close() {
      socket.close();
    },
  };
  return page;
}
