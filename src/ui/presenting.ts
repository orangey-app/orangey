/**
 * Full screen: one randomizer, or one board, filling the display. The class on
 * `body` is the single source of truth, so a view torn down while presenting
 * leaves nothing behind.
 */

export interface PresentingControls {
  /** Shown only while presenting. */
  exitButton: HTMLElement;
  /** Its label says which way the press will go. */
  presentButton: HTMLElement;
}

/**
 * Keeps the display awake while presenting, where the browser allows; a refusal
 * is harmless.
 */
let wakeLock: WakeLockSentinel | null = null;

async function holdScreenAwake(): Promise<void> {
  if (wakeLock) return;
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    // The browser releases the lock whenever the tab is hidden, so ask again when
    // it comes back.
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
