/**
 * The shell: layout, routing, the tab bar, toasts and global shortcuts.
 */

import { button, h, isTyping, openDialog, setChildren } from "./dom.ts";
import { state } from "./state.ts";
import { backTarget, currentRoute, navigate, type Route } from "./router.ts";
import { isBoard } from "../model/randomizer.ts";
import { createPlayView } from "./views/play.ts";
import { createBoardView } from "./views/board.ts";
import { createLibraryView } from "./views/library.ts";
import { createEditorView } from "./views/editor.ts";
import type { View } from "./view.ts";
import { createImportView } from "./views/importer.ts";
import { createHistoryView } from "./views/history.ts";
import { createSettingsView } from "./views/settings.ts";
import { MascotHost } from "./mascot/host.ts";
import { decodeRandomizer } from "../model/link.ts";
import { ValidationError } from "../model/validate.ts";
import { mascotLogoMarkup } from "./mascot/parts.ts";
import { storageAdvice, storageEnv } from "../storage/fsdir.ts";

const SHORTCUTS: [string, string][] = [
  ["Space or Enter", "Roll (on a board, roll all)"],
  ["Esc", "Skip the animation"],
  ["/", "Search the library"],
  ["?", "This list"],
  ["Delete / F2", "Delete or rename the focused library entry"],
  ["Alt + ↑ / ↓", "Reorder an outcome"],
  ["Ctrl/Cmd + D", "Duplicate an outcome"],
  ["Ctrl/Cmd + Z", "Undo the last deletion"],
];

export function mountApp(root: HTMLElement): MascotHost {
  const mascot = new MascotHost({ bus: state.events, feel: () => state.prefs.feel });
  state.subscribe(() => mascot.applyFeel(), ["prefs"]);

  const main = h("div", { class: "main" }, h("div", { class: "main-inner" }));
  const side = h("div", { class: "side" });
  const toasts = h("div", { class: "toasts" });
  let sideView: View | null = null;
  let mainView: View | null = null;
  let mobilePane: "main" | "side" = "main";

  const tabbar = h("div", { class: "tabbar", role: "tablist" });

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

  // Safari on iPhone and iPad clears the storage of a site left unopened for a
  // week unless it is on the Home Screen. Said once, until dismissed.
  const advice = storageAdvice(storageEnv());
  if (advice.homeScreenNotice && !state.prefs.homeScreenNoticeSeen) {
    const notice = h("div", { class: "home-screen-notice", role: "note" },
      h("p", { text: advice.note ?? "" }),
      h("div", { class: "row tight" },
        button("Got it", () => {
          notice.remove();
          void state.savePrefs({ homeScreenNoticeSeen: true });
        }, { class: "primary dismiss-notice" }),
      ),
    );
    topbar.after(notice);
  }

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
    // Full screen belongs to the shell: clear it before the incoming view is built,
    // so whatever that view asks for survives.
    document.body.classList.remove("presenting");
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
        setMain(isBoard(node.randomizer) ? createBoardView(node, route.params) : createPlayView(node, route.params));
        void state.savePrefs({ lastPath: route.path });
        break;
      }
      case "byId": {
        const node = state.library.findById(route.id);
        if (!node?.randomizer) {
          setMain(missingId(route.id));
          state.tell({ type: "link:fail", id: route.id });
          break;
        }
        setMain(isBoard(node.randomizer) ? createBoardView(node, route.params) : createPlayView(node, route.params));
        void state.savePrefs({ lastPath: node.path });
        break;
      }
      case "linked": {
        const { payload } = route;
        const stillHere = () => {
          const now = currentRoute();
          return now.name === "linked" && now.payload === payload;
        };
        setMain({ el: h("div", { class: "card", "aria-busy": "true" }, h("p", { class: "faint", text: "Opening the link…" })) });
        void decodeRandomizer(payload).then(
          (randomizer) => {
            if (!stillHere()) return;
            setMain(createPlayView(null, route.params, randomizer, route.quick === true));
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
        setMain(createEditorView(node, route.from));
        break;
      }
      case "library":
        // On a wide screen the library is already in the sidebar; the main pane shows
        // it only when the sidebar is hidden.
        setMain(sidebarVisible() ? libraryIsOnTheLeft() : createLibraryView());
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

  /**
   * A card that explains why there is nothing to roll.
   *
   * The browser tests select on the `play-card` and `broken-link` classes.
   */
  function explainCard(opts: { title: string; paragraphs: string[]; extraClass?: string; mascot?: boolean }): View {
    return {
      el: h("div", { class: `card${opts.extraClass ? ` ${opts.extraClass}` : ""}` },
        h("h1", { text: opts.title }),
        ...opts.paragraphs.map((text) => h("p", { class: "faint", text })),
        opts.mascot
          ? h("div", { class: "row" },
              button("Open the library", () => navigate("#/library"), { class: "primary" }),
              h("div", { class: "spacer" }),
              h("div", { class: "mascot-slot mascot-slot-inline" }),
            )
          : button("Open the library", () => navigate("#/library"), { class: "primary" }),
      ),
    };
  }

  function missingId(id: string): View {
    return explainCard({
      title: "Not in this library",
      paragraphs: [
        "This link points at a randomizer that is not stored in this browser. Links to your own library only work on a device where you keep that library — ask whoever made the deck to send you the file, or import it here.",
        `Its identifier is ${id}.`,
      ],
      extraClass: "play-card",
      mascot: true,
    });
  }

  function brokenLink(error: unknown): View {
    const why = error instanceof ValidationError
      ? error.issues.map((i) => i.message).join("; ")
      : (error as Error).message;
    return explainCard({
      title: "This link did not survive the trip",
      paragraphs: [
        "The wheel is meant to travel inside the link itself, and this one arrived damaged — usually a line break or a truncation somewhere between the deck and here.",
        why,
      ],
      extraClass: "play-card broken-link",
      mascot: true,
    });
  }

  function missing(path: string): View {
    return explainCard({
      title: "Not here any more",
      paragraphs: [`Nothing was found at ${path}.`],
    });
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

  /** Read from the stylesheet rather than repeating its breakpoint here. */
  function sidebarVisible(): boolean {
    return getComputedStyle(side).display !== "none";
  }

  function libraryIsOnTheLeft(): View {
    return {
      el: h("div", { class: "card" },
        h("h1", { text: "Your library" }),
        h("p", { class: "faint", text: "It is in the panel on the left: every folder and randomizer you have, with search at the top. Choose one to play it." }),
      ),
    };
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
    const opener = document.activeElement as HTMLElement | null;
    const dialog = h("dialog", { "aria-label": "Keyboard shortcuts" },
      h("h2", { text: "Keyboard shortcuts" }),
      h("table", {},
        h("tbody", {},
          ...SHORTCUTS.map(([keys, what]) =>
            h("tr", {}, h("td", { style: { paddingRight: "16px" } }, h("kbd", { text: keys })), h("td", { text: what }))),
        ),
      ),
      button("Close", () => dialog.close(), { class: "primary gap-m" }),
    );
    openDialog(dialog, opener);
  }

  document.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
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
  state.subscribe(renderToasts, ["toasts"]);
  renderRoute();
  renderToasts();
  return mascot;
}
