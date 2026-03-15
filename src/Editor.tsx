import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { EditorState, StateField, RangeSetBuilder, type Extension } from "@codemirror/state";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

export function Editor(props: Props) {
  let container!: HTMLDivElement;
  let view: EditorView | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const [outdated, setOutdated] = createSignal(false);
  const [reloadTick, setReloadTick] = createSignal(0);
  let suppressExternalUntil = 0;

  onMount(async () => {
    const unlisten = await listen<string[]>("file-changed", (event) => {
      if (props.file && event.payload.includes(props.file)) {
        if (Date.now() < suppressExternalUntil) return;
        setOutdated(true);
      }
    });
    onCleanup(unlisten);
  });

  createEffect(() => {
    const file = props.file;
    const root = props.root;
    const _tick = reloadTick();
    if (!file) {
      view?.destroy();
      view = undefined;
      return;
    }

    setOutdated(false);
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
              ...defaultKeymap,
              ...historyKeymap,
              ...closeBracketsKeymap,
              ...searchKeymap,
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
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              clearTimeout(saveTimer);
              saveTimer = setTimeout(() => {
                const contentStr = update.state.doc.toString();
                suppressExternalUntil = Date.now() + 1500;
                setOutdated(false);
                invoke("write_file", { path: file, content: contentStr });
              }, 500);
            }),
          ],
        }),
        parent: container,
      });
    })();
  });

  onCleanup(() => { view?.destroy(); clearTimeout(saveTimer); });

  return (
    <div class="editor-wrap">
      <Show when={outdated()}>
        <div class="reload-banner">
          File changed externally. <button onClick={() => setReloadTick((t) => t + 1)}>Reload</button>
        </div>
      </Show>
      <div ref={container} class="editor" />
    </div>
  );
}
