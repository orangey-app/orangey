/**
 * What the shell needs from a view: something to put on the page, and a way
 * to take it off again.
 */

export interface View {
  el: HTMLElement;
  destroy?(): void;
}
