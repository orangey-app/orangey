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

export function isPresenting(): boolean {
  return document.body.classList.contains("presenting");
}

export function setPresenting(on: boolean, controls: PresentingControls): void {
  document.body.classList.toggle("presenting", on);
  controls.exitButton.hidden = !on;
  controls.presentButton.textContent = on ? "Leave full screen" : "Full screen";
  if (on && document.documentElement.requestFullscreen) {
    void document.documentElement.requestFullscreen().catch(() => {
      /* the browser may refuse without a gesture; the layout still applies */
    });
  } else if (!on && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  }
}
