/**
 * What the shell needs from a view: something to put on the page, and a way
 * to take it off again.
 *
 * It lived in `editor.ts` because that was the first view written, which left
 * every other view importing the editor for a two-line interface.
 */

export interface View {
  el: HTMLElement;
  destroy?(): void;
}
