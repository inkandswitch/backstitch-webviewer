console.log("[patchwork] module loaded");

import { getProjectMetadata, getBranchFiles, zipBranchFiles } from "./automerge_getter";
import { createIDBFSAccessor, IDBFSEntry } from "./idbfs_accessor";

const api = new URLSearchParams(window.location.search).get("api") == "lorejam" ? "lorejam-api" : "api";

class EngineError extends Error {
  public exitCode: number;
  public errorLog: string[];
  constructor(exitCode: number, errorLog: string[] = [], msg: string | undefined = undefined) {
    super(msg);
    this.exitCode = exitCode;
    this.errorLog = errorLog;
  }
}

class ImportError extends EngineError {
}

class GameError extends EngineError {
}

const loading = document.getElementById("loading")!;
const statusText = document.getElementById("status-text")!;
const errorText = document.getElementById("error-text")!;
const progressBarInner = document.getElementById("progress-bar-inner")!;

function setStatus(msg: string) {
  statusText.textContent = msg;
}

const progressBar = document.getElementById("progress-bar")!;

function setProgress(fraction: number) {
  progressBar.classList.remove("indeterminate");
  progressBarInner.style.width = `${Math.round(fraction * 100)}%`;
}

function setIndeterminate() {
  progressBar.classList.add("indeterminate");
}

function filterErrorLog(errorLog: string[]): string[] {
  return errorLog.filter(line => !line.includes("leaked at exit") && !line.includes("WARNING:"));
}

async function showError(error: Error | ImportError | GameError | string) {
  let msg = "";
  let errorLog: string[] = [];
  if (error instanceof Error) {
    msg = error.message;
  }

  if (error instanceof EngineError) {
    errorLog = error.errorLog;
    if (error instanceof ImportError) {
      msg = "An error occurred during the import pass";
    } else if (error instanceof GameError) {
      msg = "An error occurred during the launching the game";
    } else {
      msg = "An error occurred";
    }
    if (error.exitCode) {
      msg += `exit_code: ${error.exitCode}`;
    }
    if (error.message) {
      msg += `, message: "${error.message}"`;
    }
  } else if (typeof error === "string") {
    msg = error;
  } else {
    msg = "An error occurred: " + error;
  }

  if (errorLog.length > 0) {
    errorLog = filterErrorLog(errorLog);
    // only show the last 10 lines
    errorLog = errorLog.slice(-10);
    errorLog.forEach(line => {
      errorText.innerHTML += `<li>${line}</li>`;
    });
  }

  statusText.style.display = "none";
  document.getElementById("progress-bar")!.style.display = "none";
  errorText.style.display = "block";
  errorText.textContent = msg;

  let serverReachable = false;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`/${api}/`, { signal: controller.signal });
    serverReachable = res.ok;
  } catch {}

  if (serverReachable) {
    errorText.innerHTML = `
      ${msg}
      <ul>
        <li>The project might not be synced yet</li>
        <li>The project id might be incorrect</li>
        <li>The sync server is reachable</li>
      </ul>
    `;
  } else {
    errorText.innerHTML = `
      ${msg}
      <ul>
        <li>The sync server is not reachable.</li>
      </ul>
    `;
  }
}

const projectId = new URLSearchParams(window.location.search).get("project");
console.log("[patchwork] project id from URL:", projectId);
if (!projectId) {
  const prompt = document.getElementById("project-prompt")!;
  prompt.style.display = "flex";
  document.getElementById("project-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("project-input") as HTMLInputElement;
    const id = input.value.trim();
    if (id) {
      const p = new URLSearchParams(window.location.search);
      p.set("project", id);
      window.location.search = p.toString();
    }
  });
  throw new Error("No project ID");
}

const PROJECT_PATH = "/home/web_user/project";
const PERSISTENT_PATHS = ["/home/web_user"];
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const concurrency = clamp(navigator.hardwareConcurrency ?? 1, 12, 24);

const params = new URLSearchParams(window.location.search);
const branchSelect = document.getElementById("branch-select") as HTMLSelectElement;
const branchDownloadButton = document.getElementById("branch-download") as HTMLButtonElement;
const topBar = document.getElementById("top-bar")!;
const emptyState = document.getElementById("empty-state")!;
const branchList = document.getElementById("branch-list")!;
let activeBranchFiles: Map<string, Uint8Array> | null = null;
let activeBranchFilesPromise: Promise<Map<string, Uint8Array>> | null = null;

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function triggerDownload(buffer: ArrayBuffer, filename: string) {
  const blob = new Blob([buffer], { type: "application/zip" });
  const objectUrl = URL.createObjectURL(blob);
  const downloadLink = document.createElement("a");
  downloadLink.href = objectUrl;
  downloadLink.download = filename;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  URL.revokeObjectURL(objectUrl);
}

async function getActiveBranchFiles(): Promise<Map<string, Uint8Array>> {
  if (activeBranchFiles) {
    return activeBranchFiles;
  }
  if (activeBranchFilesPromise) {
    return await activeBranchFilesPromise;
  }
  throw new Error("Project files are not available yet");
}

function sortedBranches(metadata: any) {
  const branches = Object.values(metadata.branches) as any[];
  branches.sort((a: any, b: any) => {
    if (a.id === metadata.main_doc_id) return -1;
    if (b.id === metadata.main_doc_id) return 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

function showBranchList(metadata: any) {
  const branches = sortedBranches(metadata);
  for (const branch of branches) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    const branchParams = new URLSearchParams(params);
    branchParams.set("branch", branch.id);
    a.href = "?" + branchParams.toString();
    a.textContent = branch.name;
    if (branch.created_by) {
      const span = document.createElement("span");
      span.className = "branch-author";
      span.textContent = `by ${branch.created_by}`;
      a.appendChild(span);
    }
    li.appendChild(a);
    branchList.appendChild(li);
  }
}

async function downloadZip(selectedBranchId: string, files: Map<string, Uint8Array>): Promise<void> {
  const zipBuffer = await zipBranchFiles(files);
  const selectedBranchLabel = branchSelect.selectedOptions[0]?.textContent || selectedBranchId;
  const safeProjectId = sanitizeFilePart(projectId || "project") || "project";
  const safeBranchLabel = sanitizeFilePart(selectedBranchLabel) || "branch";
  triggerDownload(zipBuffer, `project-${safeProjectId}-${safeBranchLabel}.zip`);
}

function setupBranchPicker(metadata: any, activeBranchId: string) {
  const branches = sortedBranches(metadata);

  for (const branch of branches) {
    const option = document.createElement("option");
    option.value = branch.id;
    option.textContent = branch.created_by
      ? `${branch.name} (${branch.created_by})`
      : branch.name;
    if (branch.id === activeBranchId) option.selected = true;
    branchSelect.appendChild(option);
  }

  branchSelect.addEventListener("change", () => {
    params.set("branch", branchSelect.value);
    window.location.search = params.toString();
  });

  branchDownloadButton.addEventListener("click", async () => {
    const originalLabel = branchDownloadButton.textContent || "Download zip";
    branchDownloadButton.disabled = true;
    branchDownloadButton.textContent = "Downloading...";

    try {
      const selectedBranchId = branchSelect.value;
      downloadZip(selectedBranchId, await getActiveBranchFiles());
    } catch (error) {
      console.error("[patchwork] failed to download branch zip:", error);
      branchDownloadButton.textContent = "Download failed";
      setTimeout(() => {
        branchDownloadButton.textContent = originalLabel;
      }, 1500);
      return;
    } finally {
      branchDownloadButton.disabled = false;
    }

    branchDownloadButton.textContent = originalLabel;
  });
}

function entriesToMap(entries: Record<string, IDBFSEntry>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const [path, entry] of Object.entries(entries)) {
    if (!entry.contents) {
      continue;
    }
    map.set(path, new Uint8Array(entry.contents));
  }
  return map;
}

async function launch() {
  activeBranchFilesPromise = null;
  activeBranchFiles = null;
  console.time("total");

  if (params.has("branch")) {
    loading.style.display = "flex";
    setStatus("Loading project…");
    setIndeterminate();
  }

  const metadata = await getProjectMetadata(projectId!);

  const branchId = params.get("branch") || null;

  if (!branchId) {
    showBranchList(metadata);
    emptyState.style.display = "flex";
    return;
  }

  setupBranchPicker(metadata, branchId);
  topBar.style.display = "flex";

  let canvas = document.getElementById("canvas") as HTMLCanvasElement;

  function replaceCanvas(): HTMLCanvasElement {
    const fresh = document.createElement("canvas");
    fresh.id = canvas.id;
    fresh.tabIndex = canvas.tabIndex;
    canvas.parentNode!.replaceChild(fresh, canvas);
    canvas = fresh;
    return fresh;
  }

  loading.style.display = "flex";
  setStatus("Downloading project files");
  setIndeterminate();

  console.time("fetch-project-files");
  activeBranchFilesPromise = getBranchFiles(branchId, (current, total) => {
    setProgress(current / total);
  });
  const files = await activeBranchFilesPromise;
  activeBranchFiles = files;
  console.timeEnd("fetch-project-files");
  console.log(`Fetched ${files.size} files`);

  setStatus("Importing project");
  setIndeterminate();
  console.time("import-pass");
  // clear the IDBFS for the persistent path
  try {
    const accessor = createIDBFSAccessor(PERSISTENT_PATHS[0]);
    await accessor.clear();
  } catch (error) {
    // IDBFS doesn't exist for that path yet, ignore
  }

  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let errorLog: string[] = [];
    const done = (statusCode: number) => {
      if (statusCode !== 0) {
        reject(new ImportError(statusCode, errorLog));
      }
      if (resolved) return;
      resolved = true;
      replaceCanvas();
      resolve();
    };
    const addToErrorLog = (...var_args: unknown[]) => {
      console.error(...var_args);
      errorLog.push(var_args.map(String).join(" "));
    };

    const IMPORT_TIMEOUT_MS = 60_000;

    const importEngine = new window.Engine({
      canvas,
      canvasResizePolicy: 0,
      unloadAfterInit: false,
      persistentPaths: PERSISTENT_PATHS,
      emscriptenPoolSize: concurrency,
      godotPoolSize: Math.floor(concurrency / 3),
      onExit: done,
      onPrintError: addToErrorLog
    });

    console.log("Initializing import editor...");

    importEngine.init("godot.editor").then(() => {
      console.log("Editor initalized!");
      for (const [filename, content] of files.entries()) {
        importEngine.copyToFS(`${PROJECT_PATH}/${filename.replace("res://", "")}`, content.buffer as ArrayBuffer);
      }
      setTimeout(() => {
        if (!resolved) {
          console.warn(`[patchwork] import pass timed out after ${IMPORT_TIMEOUT_MS / 1000}s, proceeding anyway`);
          done(0);
        }
      }, IMPORT_TIMEOUT_MS);

      console.log("Starting import...");
      importEngine.start({
        args: ["--path", PROJECT_PATH, "--rendering-driver", "opengl3", "--display-driver", "headless", "--audio-driver", "Dummy", "-e", "--quit"],
        persistentDrops: false,
      });
    });
  });

  console.timeEnd("import-pass");

  setStatus("Starting game");
  setIndeterminate();
  console.time("game-start");

  let errorLog: string[] = [];
  const addToErrorLog = (...var_args: unknown[]) => {
    console.error(...var_args);
    errorLog.push(var_args.map(String).join(" "));
  };
  const gameDone = (statusCode: number) => {
    if (statusCode !== 0) {
      throw new GameError(statusCode, errorLog);
    }
    console.timeEnd("game-start");
    console.log("[patchwork] game exited with status code 0");
    canvas.style.opacity = "1";
    loading.style.display = "none";
  };

  const game = new window.Engine({
    canvas,
    canvasResizePolicy: 2,
    unloadAfterInit: false,
    persistentPaths: PERSISTENT_PATHS,
    emscriptenPoolSize: concurrency,
    godotPoolSize: Math.floor(concurrency / 3),
    onExit: gameDone,
    onPrintError: addToErrorLog
  });

  await game.init("godot.editor");
  canvas.style.opacity = "1";
  loading.style.display = "none";

  await game.start({
    args: ["--path", PROJECT_PATH, "--rendering-driver", "opengl3"],
    canvas,
  });

  console.timeEnd("game-start");
  console.timeEnd("total");
  canvas.focus();
}

launch().catch((err) => {
  console.error(err);
  showError(err instanceof Error ? err.message : "An error occurred");
});
