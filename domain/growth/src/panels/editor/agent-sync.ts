import * as fs from 'node:fs';

/**
 * Bridges the filesystem and the QML editor panel.
 *
 * - Agent writes a .typ file → we detect the change and push the new text to
 *   the QML editor via onAgentChange.
 * - User edits in QML → handleEditorChange debounces and flushes to disk so
 *   the agent always reads the latest version.
 *
 * Only one file path is watched at a time; call startWatching again to switch.
 */
export class AgentEditorSync {
  #watchPath: string | null = null;
  #watcher: fs.FSWatcher | null = null;
  #debounceTimer: NodeJS.Timeout | undefined = undefined;
  // Last text we wrote ourselves so we don't echo our own writes back.
  #lastWritten: string | null = null;

  /**
   * Start watching `path`.  Replaces any prior watch.
   * `onAgentChange` is called whenever the file changes on disk from outside
   * (i.e. not as a result of our own debounced write).
   */
  startWatching(path: string, onAgentChange: (text: string) => void): void {
    this.#stopWatcher();

    this.#watchPath = path;

    // Deliver the initial content immediately so the editor is in sync.
    try {
      const initial = fs.readFileSync(path, 'utf8');
      this.#lastWritten = initial;
      onAgentChange(initial);
    } catch {
      // File may not exist yet; that's fine — the agent will create it.
    }

    this.#watcher = fs.watch(path, { persistent: false }, (event: string) => {
      if (event !== 'change') return;
      try {
        const text = fs.readFileSync(path, 'utf8');
        // Skip echo: if the content matches what we last wrote, it's our own flush.
        if (text === this.#lastWritten) return;
        this.#lastWritten = text;
        onAgentChange(text);
      } catch {
        // File temporarily unreadable during agent write; next event will retry.
      }
    });

    this.#watcher.on('error', () => {
      // Watcher invalidated (file deleted/moved); stop silently.
      this.#stopWatcher();
    });
  }

  /**
   * Called when the user edits in the QML editor.
   * Debounces 500ms then flushes to disk.
   */
  handleEditorChange(text: string): void {
    if (this.#watchPath === null) return;

    if (this.#debounceTimer !== undefined) {
      clearTimeout(this.#debounceTimer);
    }

    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      if (this.#watchPath === null) return;
      this.#lastWritten = text;
      // Synchronous write keeps it simple; the debounce already absorbs bursts.
      try {
        fs.writeFileSync(this.#watchPath, text, 'utf8');
      } catch {
        // If the path disappeared, nothing useful to do here.
      }
    }, 500);
  }

  /**
   * Stop watching and cancel any pending debounced write.
   * Safe to call multiple times.
   */
  dispose(): void {
    this.#stopWatcher();
    if (this.#debounceTimer !== undefined) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = undefined;
    }
    this.#watchPath = null;
    this.#lastWritten = null;
  }

  // ── private ──────────────────────────────────────────────────────────────

  #stopWatcher(): void {
    if (this.#watcher) {
      this.#watcher.close();
      this.#watcher = null;
    }
  }
}
