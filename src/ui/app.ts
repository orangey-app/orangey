/**
 * The shell: layout, routing, the tab bar, toasts and global shortcuts.
 */

import { button, h, setChildren } from "./dom.ts";
import { state } from "./state.ts";
import { backTarget, currentRoute, navigate, type Route } from "./router.ts";
import { createPlayView } from "./views/play.ts";
import { createLibraryView } from "./views/library.ts";
import { createEditorView, type View } from "./views/editor.ts";
import { createImportView } from "./views/importer.ts";
import { createHistoryView } from "./views/history.ts";
import { createSettingsView } from "./views/settings.ts";
import { MascotHost } from "./mascot/host.ts";
import { decodeRandomizer } from "../model/link.ts";
import { ValidationError } from "../model/validate.ts";
import { mascotLogoMarkup } from "./mascot/parts.ts";

const SHORTCUTS: [string, string][] = [
  ["Space or Enter", "Roll"],
  ["Esc", "Skip the animation"],
  ["/", "Search the library"],
  ["?", "This list"],
  ["Alt + ↑ / ↓", "Reorder an outcome"],
  ["Ctrl/Cmd + D", "Duplicate an outcome"],
  ["Ctrl/Cmd + Z", "Undo the last deletion"],
];

export function mountApp(root: HTMLElement): MascotHost {
  // The one Orangey. It listens to the bus, plays the reactions table, and
  // sits in whichever view offers a slot — only Play does.
  const mascot = new MascotHost({ bus: state.events, feel: () => state.prefs.feel });
  state.subscribe(() => mascot.applyFeel());

  const main = h("div", { class: "main" }, h("div", { class: "main-inner" }));
  const side = h("div", { class: "side" });
  const toasts = h("div", { class: "toasts" });
  let sideView: View | null = null;
  let mainView: View | null = null;
  let mobilePane: "main" | "side" = "main";

  const tabbar = h("div", { class: "tabbar", role: "tablist" });

  // Back: to the randomizer you were playing. Every screen but Play shows
  // it, because Settings, History and Import otherwise had no obvious way
  // out. It is a route, not browser history, so it never bounces between
  // two settings pages or out of the app.
  const back = button("← Back", () => navigate(backTarget(currentRoute(), state.prefs.lastPath, (p) => state.library.find(p)?.randomizer != null)), { class: "ghost back", title: "Back to play" });

  const topbar = h("div", { class: "topbar" },
    h("a", { class: "brand", href: "#/" }, h("span", { class: "mark", html: mascotLogoMarkup() }), "Orangey"),
    back,
    h("div", { class: "spacer" }),
    button("Library", () => navigate("#/library"), { class: "ghost" }),
    button("Import", () => navigate("#/import"), { class: "ghost" }),
    button("History", () => navigate("#/history"), { class: "ghost" }),
    button("Settings", () => navigate("#/settings"), { class: "ghost" }),
  );

  root.append(topbar, h("div", { class: "panes" }, side, main), tabbar, toasts);

  function setMain(view: View): void {
    mainView?.destroy?.();
    mainView = view;
    const inner = main.querySelector(".main-inner")!;
    setChildren(inner, view.el);
    main.scrollTop = 0;
    const slot = view.el.querySelector<HTMLElement>(".mascot-slot");
    if (slot) mascot.mount(slot);
    else mascot.unmount();
  }

  function ensureSide(): void {
    if (sideView) return;
    sideView = createLibraryView();
    setChildren(side, sideView.el);
  }

  function renderRoute(): void {
    const route: Route = currentRoute();
    ensureSide();

    switch (route.name) {
      case "play":
        setMain(createPlayView(null, route.params));
        break;
      case "randomizer": {
        const node = state.library.find(route.path);
        if (!node?.randomizer) {
          setMain(missing(route.path));
          break;
        }
        setMain(createPlayView(node, route.params));
        void state.savePrefs({ lastPath: route.path });
        break;
      }
      case "byId": {
        // Links on slides address a randomizer by id, so that renaming or
        // moving it does not quietly break every deck that points at it.
        const node = state.library.findById(route.id);
        if (!node?.randomizer) {
          setMain(missingId(route.id));
          state.tell({ type: "link:fail", id: route.id });
          break;
        }
        setMain(createPlayView(node, route.params));
        void state.savePrefs({ lastPath: node.path });
        break;
      }
      case "linked": {
        // The wheel is in the address. Decoding is a decompression, so it is
        // a promise; it takes about a millisecond, and the view swaps in when
        // it lands — unless the reader has already gone somewhere else.
        const { payload } = route;
        const stillHere = () => {
          const now = currentRoute();
          return now.name === "linked" && now.payload === payload;
        };
        setMain({ el: h("div", { class: "card", "aria-busy": "true" }, h("p", { class: "faint", text: "Opening the link…" })) });
        void decodeRandomizer(payload).then(
          (randomizer) => {
            if (!stillHere()) return;
            setMain(createPlayView(null, route.params, randomizer));
          },
          (error: unknown) => {
            if (!stillHere()) return;
            setMain(brokenLink(error));
            state.tell({ type: "link:fail", id: "embedded" });
          },
        );
        break;
      }
      case "edit": {
        const node = state.library.find(route.path);
        if (!node?.randomizer) {
          setMain(missing(route.path));
          break;
        }
        if (node.readOnly) {
          setMain({ el: h("div", { class: "card" }, h("p", { text: "This file was made with a newer Orangey, so it is open for reading only." })) });
          break;
        }
        setMain(createEditorView(node));
        break;
      }
      case "library":
        setMain(createLibraryView());
        break;
      case "import":
        setMain(createImportView());
        break;
      case "history":
        setMain(createHistoryView());
        break;
      case "settings":
        setMain(createSettingsView());
        break;
    }
    renderTabs(route);
    back.hidden = route.name === "play" || route.name === "randomizer" || route.name === "byId" || route.name === "linked";
  }

  function missingId(id: string): View {
    return {
      el: h("div", { class: "card play-card" },
        h("h1", { text: "Not in this library" }),
        h("p", { class: "faint", text:
          "This link points at a randomizer that is not stored in this browser. Links to your own library only work on a device where you keep that library — ask whoever made the deck to send you the file, or import it here." }),
        h("p", { class: "faint", text: `Its identifier is ${id}.` }),
        h("div", { class: "row" },
          button("Open the library", () => navigate("#/library"), { class: "primary" }),
          h("div", { class: "spacer" }),
          h("div", { class: "mascot-slot mascot-slot-inline" }),
        ),
      ),
    };
  }

  function brokenLink(error: unknown): View {
    const why = error instanceof ValidationError
      ? error.issues.map((i) => i.message).join("; ")
      : (error as Error).message;
    return {
      el: h("div", { class: "card play-card broken-link" },
        h("h1", { text: "This link did not survive the trip" }),
        h("p", { class: "faint", text:
          "The wheel is meant to travel inside the link itself, and this one arrived damaged — usually a line break or a truncation somewhere between the deck and here." }),
        h("p", { class: "faint", text: why }),
        h("div", { class: "row" },
          button("Open the library", () => navigate("#/library"), { class: "primary" }),
          h("div", { class: "spacer" }),
          h("div", { class: "mascot-slot mascot-slot-inline" }),
        ),
      ),
    };
  }

  function missing(path: string): View {
    return {
      el: h("div", { class: "card" },
        h("h1", { text: "Not here any more" }),
        h("p", { class: "faint", text: `Nothing was found at ${path}.` }),
        button("Open the library", () => navigate("#/library"), { class: "primary" }),
      ),
    };
  }

  function renderTabs(route: Route): void {
    const tabs: [string, string, string][] = [
      ["Play", "🎲", "#/"],
      ["Library", "📁", "#/library"],
      ["History", "🕘", "#/history"],
      ["Settings", "⚙", "#/settings"],
    ];
    setChildren(tabbar, 
      ...tabs.map(([label, glyph, hash]) => {
        const active =
          (hash === "#/" && (route.name === "play" || route.name === "randomizer" || route.name === "linked" || route.name === "byId")) ||
          (hash === "#/library" && (route.name === "library" || route.name === "edit")) ||
          (hash === "#/history" && route.name === "history") ||
          (hash === "#/settings" && route.name === "settings");
        return h("button", {
          "aria-current": active ? "page" : "false",
          onclick: () => {
            mobilePane = "main";
            applyPanes();
            navigate(hash);
          },
        }, h("span", { class: "glyph", text: glyph }), label);
      }),
    );
  }

  function applyPanes(): void {
    side.classList.toggle("is-active", mobilePane === "side");
    main.classList.toggle("is-hidden", mobilePane === "side");
  }

  function renderToasts(): void {
    setChildren(toasts, 
      ...state.toasts.map((toast) =>
        h("div", { class: "toast", role: "status" },
          h("span", { text: toast.text }),
          toast.action ? button(toast.actionLabel ?? "Undo", () => {
            toast.action?.();
            state.dismissToast(toast.id);
          }) : null,
          button("✕", () => state.dismissToast(toast.id), { "aria-label": "Dismiss" }),
        ),
      ),
    );
  }

  function showShortcuts(): void {
    const dialog = h("dialog", { "aria-label": "Keyboard shortcuts" },
      h("h2", { text: "Keyboard shortcuts" }),
      h("table", {},
        h("tbody", {},
          ...SHORTCUTS.map(([keys, what]) =>
            h("tr", {}, h("td", { style: { paddingRight: "16px" } }, h("kbd", { text: keys })), h("td", { text: what }))),
        ),
      ),
      button("Close", () => dialog.close(), { class: "primary", style: { marginTop: "12px" } }),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    if (typing) return;
    if (e.key === "?") {
      e.preventDefault();
      showShortcuts();
    } else if (e.key === "/") {
      e.preventDefault();
      mobilePane = "side";
      applyPanes();
      (side.querySelector('input[type="search"]') as HTMLInputElement | null)?.focus();
    }
  });

  window.addEventListener("hashchange", renderRoute);
  state.subscribe(renderToasts);
  renderRoute();
  renderToasts();
  return mascot;
}
