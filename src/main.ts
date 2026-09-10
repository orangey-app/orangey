import { mountApp } from "./ui/app.ts";
import { state } from "./ui/state.ts";
import { rollRandomizer } from "./ui/roll.ts";
import { effectiveFeel } from "./ui/feel.ts";
import { decodeRandomizer } from "./model/link.ts";
import { navigate } from "./ui/router.ts";
import { IndexedDbBackend } from "./storage/idb.ts";
import { MemoryBackend } from "./storage/memory.ts";
import { mascotTicker } from "./ui/mascot/ticker.ts";

async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("no #app element");
  root.replaceChildren(document.createTextNode("Loading…"));
  await state.load();
  root.replaceChildren();
  const mascot = mountApp(root);

  // Restore the last thing that was open, so reopening the tab mid-game does
  // not drop the GM back at a blank screen.
  if (!location.hash && state.prefs.lastPath && state.library.find(state.prefs.lastPath)) {
    navigate(`#/r/${encodeURIComponent(state.prefs.lastPath)}`);
  }

  // A debug handle for the browser test suite. Opt-in via ?debug so that an
  // ordinary session has nothing extra attached to the window.
  if (new URLSearchParams(location.search).has("debug")) {
    (globalThis as unknown as Record<string, unknown>).orangey = {
      state,
      rollRandomizer,
      effectiveFeel,
      decodeRandomizer,
      navigate,
      backends: { IndexedDbBackend, MemoryBackend },
      mascot,
      mascotTicker,
    };
  }
}

void start();
