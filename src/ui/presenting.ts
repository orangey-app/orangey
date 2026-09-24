/**
 * Full screen: one randomizer, or one board, filling the display.
 *
 * The play screen and a board both offer it and both used to carry their own
 * copy, which had already drifted — one of them swallowed the browser's
 * refusal silently and the other explained it in a comment. The class on
 * `body` is the single source of truth, so a view that is torn down while
 * presenting leaves nothing behind for the next one to trip over.
 */

export interface PresentingControls {
  /** Shown only while presenting. */
  exitButton: HTMLElement;
  /** Its label says which way the press will go. */
  presentButton: HTMLElement;
}

/**
 * The lock that keeps the display on while a wheel is on a projector.
 *
 * A table can go several minutes between rolls, which is long enough for a
 * laptop to dim and a phone to lock. The browser may refuse — it needs a
 * gesture, or the API may not exist at all — and that is fine: the worst case
 * is the screen behaving exactly as it did before.
 */
let wakeLock: WakeLockSentinel | null = null;

async function holdScreenAwake(): Promise<void> {
  if (wakeLock) return;
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    // The browser drops it whenever the tab is hidden, so it has to be asked
    // for again when the tab comes back and the wheel is still up there.
    wakeLock?.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function letScreenSleep(): void {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isPresenting()) void holdScreenAwake();
});

export function isPresenting(): boolean {
  return document.body.classList.contains("presenting");
}

export function setPresenting(on: boolean, controls: PresentingControls): void {
  document.body.classList.toggle("presenting", on);
  controls.exitButton.hidden = !on;
  controls.presentButton.textContent = on ? "Leave full screen" : "Full screen";
  if (on) void holdScreenAwake();
  else letScreenSleep();
  if (on && document.documentElement.requestFullscreen) {
    void document.documentElement.requestFullscreen().catch(() => {
      /* the browser may refuse without a gesture; the layout still applies */
    });
  } else if (!on && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  }
}
