import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor, crosshairCursor } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { SearchCursor, selectNextOccurrence } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { Decoration, DecorationSet, WidgetType, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";

type Props = { file: string | null; root: string | null };

// Simple line-based diff using LCS; returns grouped ops for clarity
type Op = { type: "ctx" | "add" | "del"; lines: string[] };

function diffLines(base: string[], cur: string[]): Op[] {
  const n = base.length, m = cur.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (base[i - 1] === cur[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const opsRev: Op[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === cur[j - 1]) {
      opsRev.push({ type: "ctx", lines: [base[i - 1]] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      opsRev.push({ type: "add", lines: [cur[j - 1]] });
      j--;
    } else {
      opsRev.push({ type: "del", lines: [base[i - 1]] });
      i--;
    }
  }
  // reverse and group consecutive ops of the same type
  const ops: Op[] = [];
  for (const op of opsRev.reverse()) {
    const last = ops[ops.length - 1];
    if (last && last.type === op.type) last.lines.push(...op.lines);
    else ops.push({ type: op.type, lines: [...op.lines] });
  }
  return ops;
}

class DeletedWidget extends WidgetType {
  constructor(private readonly lines: string[]) { super(); }
  eq(other: WidgetType) { return other instanceof DeletedWidget && this.lines.join("\n") === other.lines.join("\n"); }
  ignoreEvent() { return true; }
  toDOM() {
    const pre = document.createElement("pre");
    pre.className = "cm-del-block";
    pre.textContent = this.lines.map(l => (l === "" ? "-" : "- " + l)).join("\n");
    return pre;
  }
}

const setMatchHighlights = StateEffect.define<{ from: number; to: number }[]>();
const matchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMatchHighlights)) {
        const builder = new RangeSetBuilder<Decoration>();
        const mark = Decoration.mark({ class: "cm-find-match" });
        for (const m of [...e.value].sort((a, b) => a.from - b.from))
          builder.add(m.from, m.to, mark);
        deco = builder.finish();
      }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

export function Editor(props: Props) {
  let container!: HTMLDivElement;
  let view: EditorView | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const [reloadTick, setReloadTick] = createSignal(0);
  let suppressExternalUntil = 0;

  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchMatches, setSearchMatches] = createSignal<{ from: number; to: number }[]>([]);
  const [searchIndex, setSearchIndex] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;

  createEffect(() => { if (searchOpen()) searchInput?.focus(); });

  function runSearch(q: string) {
    if (!view) return;
    if (!q) {
      setSearchMatches([]);
      view.dispatch({ effects: setMatchHighlights.of([]) });
      return;
    }
    const matches: { from: number; to: number }[] = [];
    try {
      const cursor = new SearchCursor(view.state.doc, q);
      while (!cursor.next().done && matches.length < 1000)
        matches.push({ from: cursor.value.from, to: cursor.value.to });
    } catch { /* invalid pattern */ }
    setSearchMatches(matches);
    setSearchIndex(0);
    view.dispatch({ effects: setMatchHighlights.of(matches) });
    if (matches.length) navigateTo(0, matches);
  }

  function navigateTo(idx: number, matches = searchMatches()) {
    const m = matches[idx];
    if (!m || !view) return;
    view.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
  }

  function searchNext() {
    const m = searchMatches();
    if (!m.length) return;
    const idx = (searchIndex() + 1) % m.length;
    setSearchIndex(idx);
    navigateTo(idx);
  }

  function searchPrev() {
    const m = searchMatches();
    if (!m.length) return;
    const idx = (searchIndex() - 1 + m.length) % m.length;
    setSearchIndex(idx);
    navigateTo(idx);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatches([]);
    view?.dispatch({ effects: setMatchHighlights.of([]) });
    view?.focus();
  }

  type HoverResult = { path: string; line?: number; col?: number; preview?: string };
  type HoverInfo = { word: string; left: number; top: number; bottom: number; results: HoverResult[] | null };
  const [hoverInfo, setHoverInfo] = createSignal<HoverInfo | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let popupRef: HTMLDivElement | undefined;

  function closeHover() {
    clearTimeout(hoverTimer);
    setHoverInfo(null);
  }

  // Reposition popup every time hoverInfo changes (initial show + when results arrive).
  // Solid runs effects after DOM updates, so popupRef is set and content is rendered.
  createEffect(() => {
    const info = hoverInfo();
    if (!info || !popupRef) return;
    // rAF lets the browser finish applying styles/layout before we measure.
    requestAnimationFrame(() => {
      const el = popupRef;
      if (!el || !hoverInfo()) return;
      const { width, height } = el.getBoundingClientRect();
      const { left: aLeft, top: aTop, bottom: aBottom } = info;
      const vw = window.innerWidth, vh = window.innerHeight, pad = 8;

      // Vertical: compare available space above/below, prefer whichever has more room.
      const spaceBelow = vh - aBottom - pad;
      const spaceAbove = aTop - pad;
      let top = spaceBelow >= height || spaceBelow >= spaceAbove
        ? Math.min(aBottom + 4, vh - height - pad)
        : Math.max(pad, aTop - height - 4);

      // Horizontal: align to anchor left, shift left if it overflows the right edge.
      let left = aLeft;
      if (left + width > vw - pad) left = vw - width - pad;
      if (left < pad) left = pad;

      el.style.top  = `${top}px`;
      el.style.left = `${left}px`;
      el.style.visibility = "visible";
    });
  });

  onMount(async () => {
    const unlisten = await listen<string[]>("file-changed", (event) => {
      if (props.file && event.payload.includes(props.file)) {
        if (Date.now() < suppressExternalUntil) return;
        // Auto-reload editor content when external change detected
        setReloadTick((t) => t + 1);
      }
    });
    onCleanup(unlisten);
    const unlistenReveal = await listen<{ path: string; line?: number; col?: number }>("reveal-pos", (e) => {
      if (!view) return;
      const { path, line, col } = e.payload as any;
      if (props.file !== path) return;
      if (typeof line === "number" && line >= 1) {
        const ln = Math.min(line, view.state.doc.lines);
        const lineObj = view.state.doc.line(ln);
        const c = typeof col === "number" && col! >= 1 ? Math.min(col!, lineObj.length) : 1;
        const pos = lineObj.from + (c - 1);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
    });
    onCleanup(unlistenReveal);
  });

  createEffect(() => {
    const file = props.file;
    const root = props.root;
    const _tick = reloadTick();
    closeHover();
    if (!file) {
      view?.destroy();
      view = undefined;
      return;
    }

    let stale = false;
    onCleanup(() => { stale = true; clearTimeout(saveTimer); });

    (async () => {
      const content = await invoke<string>("read_file", { path: file });
      if (stale) return;

      // Try to get base (HEAD) contents; if unavailable, fall back to current
      let base = content;
      if (root) {
        try {
          base = await invoke<string>("git_show_file", { root, path: file, ref: "HEAD" });
        } catch (_) {
          // ignore: not a repo or no commits
        }
      }
      if (stale) return;

      const langDesc = LanguageDescription.matchFilename(languages, file);
      let langExt: Extension | [] = [];
      if (langDesc) {
        try {
          langExt = await langDesc.load();
        } catch (_) {
          langExt = [];
        }
      }
      if (stale) return;

      const baseLines = base.split("\n");

      // syntax highlighting is customized via CSS token classes (see style.css)
      const addLineDecoration = Decoration.line({ attributes: { class: "cm-line-add" } });

      const decoField = StateField.define<DecorationSet>({
        create(state) {
          return buildDecorations(state, baseLines);
        },
        update(deco, tr) {
          if (tr.docChanged) {
            return buildDecorations(tr.state, baseLines);
          }
          return deco.map(tr.changes);
        },
        provide: f => EditorView.decorations.from(f)
      });

      function buildDecorations(state: EditorState, baseL: string[]): DecorationSet {
        try {
          const curLines = state.doc.toString().split("\n");
          const ops = diffLines(baseL, curLines);
          const builder = new RangeSetBuilder<Decoration>();
          let curIndex = 1; // 1-based line numbers in doc
          for (const op of ops) {
            if (op.type === "ctx") {
              curIndex += op.lines.length;
            } else if (op.type === "add") {
              for (let k = 0; k < op.lines.length; k++) {
                const line = state.doc.line(curIndex + k);
                builder.add(line.from, line.from, addLineDecoration);
              }
              curIndex += op.lines.length;
            } else if (op.type === "del") {
              // insert a block widget before the next current line
              const pos = curIndex <= state.doc.lines ? state.doc.line(curIndex).from : state.doc.length;
              builder.add(pos, pos, Decoration.widget({ block: true, side: -1, widget: new DeletedWidget(op.lines) }));
            }
          }
          return builder.finish();
        } catch {
          return Decoration.none;
        }
      }

      function isWordChar(ch: string) {
        return /[A-Za-z0-9_$]/.test(ch);
      }

      function wordAt(state: EditorState, pos: number) {
        const doc = state.doc;
        if (pos < 0 || pos > doc.length) return null as null | { from: number; to: number };
        let from = pos, to = pos;
        while (from > 0) {
          const c = doc.sliceString(from - 1, from);
          if (!isWordChar(c)) break;
          from--;
        }
        while (to < doc.length) {
          const c = doc.sliceString(to, to + 1);
          if (!isWordChar(c)) break;
          to++;
        }
        return from < to ? { from, to } : null;
      }


      view?.destroy();
      view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            // Build our own minimal setup to avoid mixing module instances
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            keymap.of([
              { key: "Mod-f", run: () => { setSearchOpen(true); return true; } },
              { key: "Mod-d", run: selectNextOccurrence },
              ...defaultKeymap,
              ...historyKeymap,
              ...closeBracketsKeymap,
              ...completionKeymap,
              ...lintKeymap,
            ]),
            lineNumbers(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            // CSS-based syntax highlighting via `.cmt-*` token classes
            syntaxHighlighting(classHighlighter),
            langExt,
            EditorView.lineWrapping,
            decoField,
            matchHighlightField,
            EditorState.allowMultipleSelections.of(true),
            EditorView.clickAddsSelectionRange.of(e => e.altKey),
            crosshairCursor(),
            EditorView.domEventHandlers({ scroll() { closeHover(); return false; } }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                  const contentStr = update.state.doc.toString();
                  suppressExternalUntil = Date.now() + 1500;
                  invoke("write_file", { path: file, content: contentStr });
                }, 500);
              }
              if (update.selectionSet) {
                const cursor = update.state.selection.main;
                if (!cursor.empty) { closeHover(); return; }
                const w = wordAt(update.state, cursor.head);
                if (!w || w.to - w.from < 2) { closeHover(); return; }
                const word = update.state.doc.sliceString(w.from, w.to);
                if (hoverInfo()?.word === word) return;
                closeHover();
                const coords = update.view.coordsAtPos(w.from);
                if (!coords) return;
                const currentRoot = root;
                hoverTimer = setTimeout(() => {
                  setHoverInfo({ word, left: coords.left, top: coords.top, bottom: coords.bottom, results: null });
                  if (!currentRoot) { setHoverInfo(h => h?.word === word ? { ...h, results: [] } : h); return; }
                  invoke<HoverResult[]>("search_all", { root: currentRoot, query: word, limit: 60 })
                    .then(results => setHoverInfo(h => h?.word === word ? { ...h, results: results.filter(r => r.line != null) } : h))
                    .catch(() => setHoverInfo(h => h?.word === word ? { ...h, results: [] } : h));
                }, 300);
              }
            }),
          ],
        }),
        parent: container,
      });
    })();
  });

  onCleanup(() => { view?.destroy(); clearTimeout(saveTimer); clearTimeout(hoverTimer); });

  return (
    <div class="editor-wrap">
      <Show when={searchOpen()}>
        <div class="find-bar" onKeyDown={e => { if (e.key === "Escape") closeSearch(); }}>
          <input
            ref={searchInput}
            type="text"
            placeholder="Find"
            value={searchQuery()}
            onInput={e => { setSearchQuery(e.currentTarget.value); runSearch(e.currentTarget.value); }}
            onKeyDown={e => { if (e.key === "Enter") e.shiftKey ? searchPrev() : searchNext(); }}
          />
          <span class="find-count">
            {searchMatches().length > 0 ? `${searchIndex() + 1} / ${searchMatches().length}` : searchQuery() ? "0" : ""}
          </span>
          <button onClick={searchPrev}>←</button>
          <button onClick={searchNext}>→</button>
          <button class="find-close" onClick={closeSearch}>×</button>
        </div>
      </Show>
      <div ref={container} class="editor" />
      <Show when={hoverInfo()}>
        {(info) => (
          <div
            class="hover-popup"
            style={{ visibility: "hidden" }}
            ref={el => { popupRef = el; }}
          >
            <Show when={info().results !== null} fallback={<div class="hover-row hover-loading">searching…</div>}>
              <Show when={info().results!.length > 0} fallback={<div class="hover-row hover-empty">no definitions found</div>}>
                <For each={info().results!}>
                  {(r) => {
                    const rel = props.root && r.path.startsWith(props.root + "/")
                      ? r.path.slice(props.root.length + 1)
                      : r.path;
                    return (
                      <div class="hover-row hover-result" onClick={() => { closeHover(); emit("open-file", r); }}>
                        <span class="hover-location"><span class="hover-path">{rel}</span><Show when={r.line}><span class="hover-line">:{r.line}</span></Show></span>
                        <Show when={r.preview}><span class="hover-preview">{r.preview}</span></Show>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
