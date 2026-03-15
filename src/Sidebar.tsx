import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

type FileNode = { name: string; path: string; is_dir: boolean };

type Props = {
  root: string | null;
  dirtyFiles: Set<string>;
  createdFiles: Set<string>;
  removedFiles: Set<string>;
  onSelect: (path: string) => void;
  selectedPath?: string | null;
};

export function Sidebar(props: Props) {
  const [filterChanged, setFilterChanged] = createSignal(false);
  const [nodes] = createResource(
    () => props.root ?? undefined,
    (path) => invoke<FileNode[]>("read_dir", { path })
  );

  const changedList = createMemo(() => {
    const set = props.dirtyFiles;
    if (!set || set.size === 0) return [] as string[];
    const arr = Array.from(set);
    // Sort by relative path for readability
    const root = props.root ?? "";
    arr.sort((a, b) => a.replace(root + "/", "").localeCompare(b.replace(root + "/", "")));
    return arr;
  });

  return (
    <aside>
      <Show when={props.root} fallback={<p class="hint">Run: ide &lt;path&gt;</p>}>
        <Show when={!filterChanged()} fallback={
          <ul>
            <For each={changedList()}>
              {(p) => {
                const rel = (props.root && p.startsWith(props.root + "/")) ? p.slice((props.root + "/").length) : p;
                const isCreated = props.createdFiles.has(p);
                const isRemoved = props.removedFiles.has(p);
                return (
                  <li>
                    <span
                      class="file"
                      classList={{ created: isCreated, removed: isRemoved, selected: p === props.selectedPath }}
                      onClick={() => props.onSelect(p)}
                      title={p}
                    >
                      {rel}
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        }>
          <ul>
            <For each={nodes() ?? []}>
              {(node) => (
                <TreeNode
                  node={node}
                  dirtyFiles={props.dirtyFiles}
                  createdFiles={props.createdFiles}
                  removedFiles={props.removedFiles}
                  onSelect={props.onSelect}
                  selectedPath={props.selectedPath}
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <div class="sidebar-footer">
        <button
          type="button"
          class="icon"
          title="Toggle theme"
          aria-label="Toggle theme"
          onClick={() => emit("toggle-theme", {})}
        >
          {/* Moon (crescent) icon */}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          classList={{ icon: true, active: filterChanged() }}
          title={filterChanged() ? "Show all" : "Show changed only"}
          aria-label="Toggle changed filter"
          onClick={() => setFilterChanged(v => !v)}
        >
          {/* Sort (three lines decreasing) icon */}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="5" y="6" width="14" height="2" fill="currentColor"/>
            <rect x="7" y="11" width="10" height="2" fill="currentColor"/>
            <rect x="9" y="16" width="6" height="2" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </aside>
  );
}

// A node is dirty if:
// - its exact path is in dirtyFiles (modified tracked file)
// - it's inside an untracked dir that git reports as "dir/" (trailing slash)
// - it's a directory that contains any dirty path
function isDirty(path: string, dirtyFiles: Set<string>): boolean {
  if (dirtyFiles.has(path)) return true;
  const withSlash = path + "/";
  for (const d of dirtyFiles) {
    if (d.startsWith(withSlash)) return true;       // dir contains a dirty file
    if (d.endsWith("/") && path.startsWith(d)) return true; // inside untracked dir
  }
  return false;
}

function TreeNode(props: {
  node: FileNode;
  dirtyFiles: Set<string>;
  createdFiles: Set<string>;
  removedFiles: Set<string>;
  onSelect: (path: string) => void;
  selectedPath?: string | null;
}) {
  const [open, setOpen] = createSignal(false);
  const [children] = createResource(
    () => (props.node.is_dir && open() ? props.node.path : undefined),
    (path) => invoke<FileNode[]>("read_dir", { path })
  );

  return (
    <li>
      <span
        class={props.node.is_dir ? "dir" : "file"}
        classList={{
          dirty: isDirty(props.node.path, props.dirtyFiles),
          created: !props.node.is_dir && props.createdFiles.has(props.node.path),
          removed: !props.node.is_dir && props.removedFiles.has(props.node.path),
          selected: !props.node.is_dir && props.node.path === props.selectedPath,
        }}
        onClick={() => {
          if (props.node.is_dir) setOpen((o) => !o);
          else props.onSelect(props.node.path);
        }}
      >
        {props.node.is_dir ? (open() ? "▾ " : "▸ ") : "  "}
        {props.node.name}
      </span>
      <Show when={open()}>
        <ul>
          <For each={children() ?? []}>
            {(child) => (
              <TreeNode
                node={child}
                dirtyFiles={props.dirtyFiles}
                createdFiles={props.createdFiles}
                removedFiles={props.removedFiles}
                onSelect={props.onSelect}
                selectedPath={props.selectedPath}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}
