/**
 * Typing `{@` in an outcome opens a list of the library's tables; picking one
 * writes `{@Name}` there. The editor keeps the table's id behind the name
 * (model/refs.ts), so this only has to say which table was meant.
 */

import { h } from "../dom.ts";

export interface RefCandidate {
  id: string;
  name: string;
  /** Where it is, to tell two tables of one name apart. */
  folder: string;
}

const OPEN_REF = /\{@([^{}|]{0,80})$/;
const LIMIT = 8;

/**
 * Watches the text inputs under `host` that match `selector`. `onPick` is told
 * which table was picked before the input event fires, so the save that
 * follows knows its id even when two tables share the name.
 */
export function attachRefPicker(host: HTMLElement, selector: string, opts: {
  candidates: () => RefCandidate[];
  onPick: (picked: RefCandidate) => void;
}): () => void {
  let menu: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let matches: RefCandidate[] = [];
  let active = 0;

  const close = () => {
    menu?.remove();
    menu = null;
    input = null;
  };

  function open(el: HTMLInputElement, query: string): void {
    const q = query.trim().toLowerCase();
    const all = opts.candidates();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    matches = [...starts, ...contains].slice(0, LIMIT);
    if (matches.length === 0) {
      close();
      return;
    }
    active = Math.min(active, matches.length - 1);
    input = el;
    const dupes = new Set(matches.map((m) => m.name.toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i));
    const list = h("ul", { class: "ref-picker", role: "listbox", "aria-label": "Tables to roll here" },
      ...matches.map((m, i) =>
        h("li", {
          role: "option",
          class: i === active ? "active" : "",
          "aria-selected": String(i === active),
          onmousedown: (e: Event) => {
            e.preventDefault();
            choose(i);
          },
        },
          h("span", { class: "ref-name", text: m.name }),
          dupes.has(m.name.toLowerCase()) || m.folder ? h("span", { class: "ref-folder", text: m.folder || "top level" }) : null,
        )),
    );
    const r = el.getBoundingClientRect();
    list.style.left = `${Math.round(r.left)}px`;
    list.style.top = `${Math.round(r.bottom + 2)}px`;
    list.style.minWidth = `${Math.round(Math.max(200, r.width))}px`;
    menu?.remove();
    menu = list;
    document.body.appendChild(list);
  }

  function choose(i: number): void {
    const el = input;
    const picked = matches[i];
    if (!el || !picked) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const m = OPEN_REF.exec(before);
    if (!m) return close();
    const start = caret - m[0].length;
    // A "}" already after the caret (typed by hand) is used, not doubled.
    const after = el.value.slice(caret).replace(/^[^{}|]*\}/, "");
    const token = `{@${picked.name.replace(/[{}|]/g, "")}}`;
    el.value = el.value.slice(0, start) + token + after;
    const at = start + token.length;
    el.setSelectionRange(at, at);
    close();
    opts.onPick(picked);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const oninput = (e: Event) => {
    const el = e.target as HTMLInputElement;
    if (!(el instanceof HTMLInputElement) || !el.matches(selector)) return;
    const m = OPEN_REF.exec(el.value.slice(0, el.selectionStart ?? el.value.length));
    if (m) open(el, m[1]);
    else close();
  };
  const onkeydown = (e: Event) => {
    const k = e as KeyboardEvent;
    if (!menu || e.target !== input) return;
    if (k.key === "ArrowDown" || k.key === "ArrowUp") {
      active = (active + (k.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
      open(input!, OPEN_REF.exec(input!.value.slice(0, input!.selectionStart ?? 0))?.[1] ?? "");
    } else if (k.key === "Enter" || k.key === "Tab") {
      choose(active);
    } else if (k.key === "Escape") {
      close();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onblur = (e: Event) => {
    if (e.target === input) close();
  };
  host.addEventListener("input", oninput);
  host.addEventListener("keydown", onkeydown, true);
  host.addEventListener("focusout", onblur);
  return () => {
    close();
    host.removeEventListener("input", oninput);
    host.removeEventListener("keydown", onkeydown, true);
    host.removeEventListener("focusout", onblur);
  };
}
