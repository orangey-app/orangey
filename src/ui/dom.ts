/**
 * A very small DOM helper.
 *
 * Views build elements with `h`, keep references to the few nodes they update,
 * and update those in place. There is no virtual DOM and no re-render of whole
 * views: the outcome table has text fields in it, and nothing loses a user's
 * cursor faster than rebuilding the row they are typing in.
 */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

function applyProps(el: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.setAttribute("class", String(value));
    else if (key === "text") el.textContent = String(value);
    else if (key === "html") el.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign((el as HTMLElement).style, value);
    else if (key === "style") el.setAttribute("style", String(value));
    else if (key === "dataset") Object.assign((el as HTMLElement).dataset, value as Record<string, string>);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "value" && el instanceof HTMLInputElement) el.value = String(value);
    else if (key === "checked" && el instanceof HTMLInputElement) el.checked = value === true;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function s(tag: string, props: Props | null = null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "text") el.textContent = String(value);
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * Replace an element's children, skipping nulls.
 *
 * `Element.replaceChildren` stringifies null into the text "null", which is
 * exactly what a conditional child produces when the condition is false.
 */
export function setChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function on<K extends keyof WindowEventMap>(
  target: EventTarget,
  type: K | string,
  handler: (ev: Event) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

/** Icon-only buttons still need a name for screen readers and tooltips. */
export function iconButton(label: string, glyph: string, onClick: () => void, extra: Props = {}): HTMLButtonElement {
  return h("button", {
    class: "icon-button",
    type: "button",
    title: label,
    "aria-label": label,
    onclick: onClick,
    ...extra,
  }, glyph);
}

export function button(label: string, onClick: () => void, extra: Props = {}): HTMLButtonElement {
  return h("button", { type: "button", onclick: onClick, ...extra }, label);
}

export function field(labelText: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "field" }, h("span", { class: "field-label", text: labelText }), input,
    hint ? h("span", { class: "field-hint", text: hint }) : null);
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/* ---- dialogs and menus ----------------------------------------------------
 * Replacements for prompt(), confirm() and ad-hoc dropdowns. They return
 * promises, close on Escape, and restore focus to the element that opened
 * them, which the browser's built-ins do not.
 */

function openDialog(dialog: HTMLDialogElement, opener?: HTMLElement | null): void {
  dialog.addEventListener("close", () => {
    dialog.remove();
    opener?.focus();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}

/** Ask for a line of text. Resolves to null when cancelled. */
export function askText(
  title: string,
  opts: { label?: string; value?: string; confirm?: string; placeholder?: string; opener?: HTMLElement | null } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: opts.value ?? "", placeholder: opts.placeholder ?? "", "aria-label": opts.label ?? title });
    let answered = false;
    const done = (value: string | null) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };
    const dialog = h("dialog", { "aria-label": title },
      h("form", { method: "dialog", onsubmit: (e: Event) => { e.preventDefault(); done(input.value.trim() || null); } },
        h("h2", { text: title }),
        opts.label ? h("label", { class: "field" }, h("span", { class: "field-label", text: opts.label }), input) : input,
        h("div", { class: "row", style: { marginTop: "14px" } },
          h("div", { class: "spacer" }),
          button("Cancel", () => done(null), { type: "button" }),
          h("button", { type: "submit", class: "primary" }, opts.confirm ?? "OK"),
        ),
      ),
    );
    dialog.addEventListener("close", () => done(null));
    openDialog(dialog, opts.opener);
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question. Resolves true when confirmed. */
export function askConfirm(
  title: string,
  text: string,
  opts: { confirm?: string; danger?: boolean; opener?: HTMLElement | null } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value: boolean) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };
    const ok = button(opts.confirm ?? "OK", () => done(true), { class: opts.danger ? "primary danger-primary" : "primary" });
    const dialog = h("dialog", { "aria-label": title },
      h("h2", { text: title }),
      h("p", { text }),
      h("div", { class: "row", style: { marginTop: "14px" } },
        h("div", { class: "spacer" }),
        button("Cancel", () => done(false)),
        ok,
      ),
    );
    dialog.addEventListener("close", () => done(false));
    openDialog(dialog, opts.opener);
    ok.focus();
  });
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a rule above this item. */
  separator?: boolean;
}

/** A small menu anchored under a button. Closes on Escape, outside click, or choice. */
export function openMenu(anchor: HTMLElement, items: MenuItem[], label = "Menu"): void {
  document.querySelector(".menu")?.remove();
  const menu = h("div", { class: "menu", role: "menu", "aria-label": label });
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    anchor.setAttribute("aria-expanded", "false");
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) close();
  };
  const onKey = (e: KeyboardEvent) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(at + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    }
  };
  for (const item of items) {
    if (item.separator) menu.appendChild(h("div", { class: "menu-rule", role: "separator" }));
    menu.appendChild(
      h("button", {
        type: "button",
        role: "menuitem",
        class: `menu-item${item.danger ? " danger" : ""}`,
        disabled: item.disabled ? true : undefined,
        onclick: () => {
          close();
          item.onSelect();
        },
      }, item.label),
    );
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 240)}px`;
  document.body.appendChild(menu);
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  (menu.querySelector("button:not([disabled])") as HTMLButtonElement | null)?.focus();
}

/** Pick a folder from the library tree. Resolves to the path, or null. */
export function askFolder(
  title: string,
  folders: { path: string; name: string; depth: number }[],
  current: string,
  opener?: HTMLElement | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value: string | null) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };
    let chosen = current;
    const list = h("div", { class: "folder-pick", role: "listbox", "aria-label": title });
    const render = () => {
      setChildren(list, ...folders.map((f) =>
        h("button", {
          type: "button",
          role: "option",
          class: "tree-row",
          "aria-selected": f.path === chosen ? "true" : "false",
          "aria-current": f.path === chosen ? "true" : "false",
          style: { paddingLeft: `${8 + f.depth * 16}px` },
          onclick: () => { chosen = f.path; render(); },
          ondblclick: () => done(f.path),
        }, h("span", { class: "glyph", text: "📁" }), h("span", { class: "name", text: f.name }))));
    };
    render();
    const dialog = h("dialog", { "aria-label": title },
      h("h2", { text: title }),
      list,
      h("div", { class: "row", style: { marginTop: "14px" } },
        h("div", { class: "spacer" }),
        button("Cancel", () => done(null)),
        button("Move here", () => done(chosen), { class: "primary" }),
      ),
    );
    dialog.addEventListener("close", () => done(null));
    openDialog(dialog, opener);
  });
}
