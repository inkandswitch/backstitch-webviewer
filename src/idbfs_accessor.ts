import { openDB, type DBSchema, type IDBPDatabase } from "idb";
// how this is laid out:
// database name is the name of a directory on the virtual filesystem, e.g. "/home/web_user"
// store name is "FILE_DATA"
// FILE_DATA entries are like this:
// key: path
// value: {
//   timestamp: string // date in ISO string format
//   mode: number
//   contents?: ArrayBuffer
// }
// if contents is not present, the entry is a directory

const DEFAULT_STORE_NAME = "FILE_DATA";
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const PERMISSION_MASK = 0o777;

export const IDBFS_DEFAULT_FILE_PERMISSIONS = 0o644;
export const IDBFS_DEFAULT_DIRECTORY_PERMISSIONS = 0o755;

export function getPermissionBits(mode: number): number {
  return mode & PERMISSION_MASK;
}

export function isRegularFileMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFREG;
}

export function isDirectoryMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR;
}

export function makeRegularFileMode(permissions: number = IDBFS_DEFAULT_FILE_PERMISSIONS): number {
  return S_IFREG | (permissions & PERMISSION_MASK);
}

export function makeDirectoryMode(
  permissions: number = IDBFS_DEFAULT_DIRECTORY_PERMISSIONS,
): number {
  return S_IFDIR | (permissions & PERMISSION_MASK);
}

export function formatModeOctal(mode: number): string {
  return mode.toString(8);
}

export function formatPermissionsSymbolic(mode: number): string {
  const bits = getPermissionBits(mode);
  const groups = [6, 3, 0];
  return groups
    .map((shift) => {
      const group = (bits >> shift) & 0o7;
      return `${group & 0o4 ? "r" : "-"}${group & 0o2 ? "w" : "-"}${group & 0o1 ? "x" : "-"}`;
    })
    .join("");
}

interface IDBFSPersistedEntry {
  timestamp: Date | number | string;
  mode: number;
  contents?: ArrayBuffer;
  content?: ArrayBuffer;
}

interface IDBFSDatabaseSchema extends DBSchema {
  FILE_DATA: {
    key: string;
    value: IDBFSPersistedEntry;
    indexes: {
      timestamp: Date | number | string;
    };
  };
}

export interface IDBFSEntry {
  timestamp: Date;
  mode: number;
  kind: IDBFSEntryKind;
  contents?: ArrayBuffer;
}

export type IDBFSEntryKind = "file" | "directory";

export interface IDBFSWritableEntry {
  timestamp: Date | number | string;
  mode: number;
  kind?: IDBFSEntryKind;
  contents?: ArrayBuffer | ArrayBufferView;
}

export interface IDBFSWritableFileEntry {
  timestamp: Date | number | string;
  mode: number;
  contents: ArrayBuffer | ArrayBufferView;
}

export interface IDBFSWritableDirectoryEntry {
  timestamp: Date | number | string;
  mode: number;
}

export interface CreateIDBFSAccessorOptions {
  storeName?: string;
}

export type IDBFSEntryIterator = (path: string, entry: IDBFSEntry) => void | Promise<void>;

export interface IDBFSStore {
  listPaths(): Promise<string[]>;
  get(path: string): Promise<IDBFSEntry | null>;
  getRecursive(path: string): Promise<Record<string, IDBFSEntry>>;
  getKind(path: string): Promise<IDBFSEntryKind | null>;
  isFile(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  mkdirp(path: string, timestamp?: Date | number | string): Promise<void>;
  put(path: string, entry: IDBFSWritableEntry): Promise<void>;
  putFile(path: string, entry: IDBFSWritableFileEntry): Promise<void>;
  putDirectory(path: string, entry: IDBFSWritableDirectoryEntry): Promise<void>;
  delete(path: string): Promise<void>;
  deleteRecursive(path: string): Promise<void>;
  clear(): Promise<void>;
  putMany(entries: Record<string, IDBFSWritableEntry>): Promise<void>;
  deleteMany(paths: string[]): Promise<void>;
  forEachEntry(iterator: IDBFSEntryIterator): Promise<void>;
  exists(path: string): Promise<boolean>;
  touch(path: string, timestamp?: Date | number | string): Promise<void>;
  close(): Promise<void>;
}

export class IDBFSAccessorError extends Error {
  public readonly operation: string;
  public readonly dbName: string;
  public readonly storeName: string;
  public readonly cause: unknown;

  constructor(
    operation: string,
    dbName: string,
    storeName: string,
    message: string,
    cause?: unknown,
  ) {
    super(`[IDBFS:${operation}] ${message} (db="${dbName}", store="${storeName}")`);
    this.name = "IDBFSAccessorError";
    this.operation = operation;
    this.dbName = dbName;
    this.storeName = storeName;
    this.cause = cause;
  }
}

export function createIDBFSAccessor(
  dbName: string,
  opts: CreateIDBFSAccessorOptions = {},
): IDBFSStore {
  const storeName = opts.storeName ?? DEFAULT_STORE_NAME;

  let dbPromise: Promise<IDBPDatabase<IDBFSDatabaseSchema>> | null = null;

  const openDatabase = async (operation: string): Promise<IDBPDatabase<IDBFSDatabaseSchema>> => {
    if (!dbPromise) {
      dbPromise = openDB<IDBFSDatabaseSchema>(dbName).catch((error) => {
        dbPromise = null;
        throw wrapError(operation, "Failed to open IndexedDB database", error);
      });
    }
    return dbPromise;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    operation: string,
    run: (store: any) => Promise<T> | T,
  ): Promise<T> => {
    const db = await openDatabase(operation);
    const tx = db.transaction(storeName as never, mode);
    const store = tx.store as any;
    try {
      const result = await run(store);
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // noop: transaction may already be complete/aborted.
      }
      await tx.done.catch(() => undefined);
      throw wrapError(operation, "IndexedDB transaction failed", error);
    }
  };

  const wrapError = (operation: string, message: string, cause: unknown): IDBFSAccessorError => {
    if (cause instanceof IDBFSAccessorError) {
      return cause;
    }
    return new IDBFSAccessorError(operation, dbName, storeName, message, cause);
  };

  const normalizePath = (path: string, operation: string): string => {
    if (typeof path !== "string" || path.length === 0) {
      throw new IDBFSAccessorError(operation, dbName, storeName, "Path must be a non-empty string");
    }
    return path;
  };

  const normalizeMode = (mode: unknown, operation: string): number => {
    if (typeof mode !== "number" || !Number.isFinite(mode)) {
      throw new IDBFSAccessorError(
        operation,
        dbName,
        storeName,
        `Invalid mode value: ${String(mode)}`,
      );
    }
    return mode;
  };

  const normalizeTimestamp = (timestamp: unknown, operation: string): Date => {
    if (timestamp instanceof Date) {
      if (Number.isNaN(timestamp.getTime())) {
        throw new IDBFSAccessorError(operation, dbName, storeName, "Invalid Date timestamp");
      }
      return new Date(timestamp.getTime());
    }

    if (typeof timestamp === "number" || typeof timestamp === "string") {
      const normalized = new Date(timestamp);
      if (Number.isNaN(normalized.getTime())) {
        throw new IDBFSAccessorError(
          operation,
          dbName,
          storeName,
          `Invalid timestamp value: ${String(timestamp)}`,
        );
      }
      return normalized;
    }

    throw new IDBFSAccessorError(
      operation,
      dbName,
      storeName,
      `Unsupported timestamp type: ${typeof timestamp}`,
    );
  };

  const normalizeContents = (value: unknown, operation: string): ArrayBuffer | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (value instanceof ArrayBuffer) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      return bytes.slice().buffer;
    }
    throw new IDBFSAccessorError(
      operation,
      dbName,
      storeName,
      "Entry contents must be an ArrayBuffer or ArrayBufferView",
    );
  };

  const decodeEntry = (value: unknown, operation: string): IDBFSEntry => {
    if (value === null || typeof value !== "object") {
      throw new IDBFSAccessorError(
        operation,
        dbName,
        storeName,
        "Malformed IDBFS record: expected object value",
      );
    }
    const persisted = value as Partial<IDBFSPersistedEntry>;
    const timestamp = normalizeTimestamp(persisted.timestamp, operation);
    const mode = normalizeMode(persisted.mode, operation);
    const contents = normalizeContents(persisted.contents ?? persisted.content, operation);
    const kind: IDBFSEntryKind = contents === undefined ? "directory" : "file";
    return { timestamp, mode, kind, contents };
  };

  const encodeEntry = (entry: IDBFSWritableEntry, operation: string): IDBFSPersistedEntry => {
    const timestamp = normalizeTimestamp(entry.timestamp, operation).toISOString();
    const mode = normalizeMode(entry.mode, operation);
    const contents = normalizeContents(entry.contents, operation);
    const kind: IDBFSEntryKind = entry.kind ?? (contents === undefined ? "directory" : "file");

    if (kind === "directory" && contents !== undefined) {
      throw new IDBFSAccessorError(
        operation,
        dbName,
        storeName,
        "Directory entries must not contain contents",
      );
    }

    if (kind === "file" && contents === undefined) {
      throw new IDBFSAccessorError(
        operation,
        dbName,
        storeName,
        "File entries must include contents",
      );
    }

    const encoded: IDBFSPersistedEntry = {
      timestamp,
      mode,
    };

    if (kind === "file") {
      // Write both keys to remain compatible with existing Godot IDBFS formats.
      encoded.contents = contents;
      encoded.content = contents;
    }

    return encoded;
  };

  const getEntryOrNull = async (
    store: any,
    path: string,
    operation: string,
  ): Promise<IDBFSEntry | null> => {
    const value = await store.get(path);
    if (value === undefined) {
      return null;
    }
    return decodeEntry(value, operation);
  };

  const putEntry = async (
    store: any,
    path: string,
    entry: IDBFSWritableEntry,
    operation: string,
  ): Promise<void> => {
    await store.put(encodeEntry(entry, operation), path);
  };

  const getDirectoryPathsToCreate = (path: string): string[] => {
    const trimmed = path.trim();
    if (trimmed === "/") {
      return ["/"];
    }

    const normalized = trimmed.replace(/\/+/g, "/").replace(/\/$/, "");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const directories: string[] = [];
    let current = "";

    for (const segment of segments) {
      current = `${current}/${segment}`;
      directories.push(current);
    }

    return directories;
  };

  const normalizeRecursiveTarget = (path: string, operation: string): string => {
    const normalized = normalizePath(path, operation).replace(/\/+/g, "/");
    if (normalized === "/") {
      return "/";
    }
    return normalized.replace(/\/$/, "");
  };

  const pathIsInTree = (candidatePath: string, treeRoot: string): boolean => {
    if (treeRoot === "/") {
      return candidatePath.startsWith("/");
    }
    return candidatePath === treeRoot || candidatePath.startsWith(`${treeRoot}/`);
  };

  const accessor: IDBFSStore = {
    async listPaths(): Promise<string[]> {
      return withStore("readonly", "listPaths", async (store) => {
        const keys = await store.getAllKeys();
        return keys.map((key) => String(key)).sort((a, b) => a.localeCompare(b));
      });
    },

    async get(path: string): Promise<IDBFSEntry | null> {
      const normalizedPath = normalizePath(path, "get");
      return withStore("readonly", "get", async (store) =>
        getEntryOrNull(store, normalizedPath, "get"),
      );
    },

    async getRecursive(path: string): Promise<Record<string, IDBFSEntry>> {
      const targetPath = normalizeRecursiveTarget(path, "getRecursive");
      return withStore("readonly", "getRecursive", async (store) => {
        const targetEntry = await getEntryOrNull(store, targetPath, "getRecursive");
        if (targetEntry === null) {
          return {};
        }

        if (targetEntry.kind === "file") {
          return { [targetPath]: targetEntry };
        }

        const results: Record<string, IDBFSEntry> = {};
        let cursor = await store.openCursor();
        while (cursor) {
          const currentPath = String(cursor.key);
          if (pathIsInTree(currentPath, targetPath)) {
            results[currentPath] = decodeEntry(cursor.value, "getRecursive");
          }
          cursor = await cursor.continue();
        }
        return results;
      });
    },

    async getKind(path: string): Promise<IDBFSEntryKind | null> {
      const entry = await accessor.get(path);
      return entry?.kind ?? null;
    },

    async isFile(path: string): Promise<boolean> {
      return (await accessor.getKind(path)) === "file";
    },

    async isDirectory(path: string): Promise<boolean> {
      return (await accessor.getKind(path)) === "directory";
    },

    async mkdirp(path: string, timestamp: Date | number | string = new Date()): Promise<void> {
      if (!path.startsWith(dbName)) {
        throw new IDBFSAccessorError(
          "mkdirp",
          dbName,
          storeName,
          `Path must start with database name: ${dbName}`,
        );
      }
      const directories = getDirectoryPathsToCreate(normalizePath(path, "mkdirp"));
      const normalizedTimestamp = normalizeTimestamp(timestamp, "mkdirp").toISOString();

      return withStore("readwrite", "mkdirp", async (store) => {
        for (const directoryPath of directories) {
          const existing = await getEntryOrNull(store, directoryPath, "mkdirp");
          if (existing?.kind === "file") {
            throw new IDBFSAccessorError(
              "mkdirp",
              dbName,
              storeName,
              `Cannot create directory over file: ${directoryPath}`,
            );
          }
          if (existing?.kind === "directory") {
            continue;
          }
          await putEntry(
            store,
            directoryPath,
            {
              timestamp: normalizedTimestamp,
              mode: makeDirectoryMode(),
              kind: "directory",
            },
            "mkdirp",
          );
        }
      });
    },

    async put(path: string, entry: IDBFSWritableEntry): Promise<void> {
      const normalizedPath = normalizePath(path, "put");
      return withStore("readwrite", "put", async (store) => {
        await putEntry(store, normalizedPath, entry, "put");
      });
    },

    async putFile(path: string, entry: IDBFSWritableFileEntry): Promise<void> {
      return accessor.put(path, { ...entry, kind: "file" });
    },

    async putDirectory(path: string, entry: IDBFSWritableDirectoryEntry): Promise<void> {
      return accessor.put(path, { ...entry, kind: "directory" });
    },

    async delete(path: string): Promise<void> {
      const normalizedPath = normalizePath(path, "delete");
      return withStore("readwrite", "delete", async (store) => {
        await store.delete(normalizedPath);
      });
    },

    async deleteRecursive(path: string): Promise<void> {
      const targetPath = normalizeRecursiveTarget(path, "deleteRecursive");
      return withStore("readwrite", "deleteRecursive", async (store) => {
        const targetEntry = await getEntryOrNull(store, targetPath, "deleteRecursive");
        if (targetEntry === null) {
          return;
        }

        if (targetEntry.kind === "file") {
          await store.delete(targetPath);
          return;
        }

        const keysToDelete: string[] = [];
        let cursor = await store.openCursor();
        while (cursor) {
          const currentPath = String(cursor.key);
          if (pathIsInTree(currentPath, targetPath)) {
            keysToDelete.push(currentPath);
          }
          cursor = await cursor.continue();
        }

        for (const key of keysToDelete) {
          await store.delete(key);
        }
      });
    },

    async clear(): Promise<void> {
      return withStore("readwrite", "clear", async (store) => {
        await store.clear();
      });
    },

    async putMany(entries: Record<string, IDBFSWritableEntry>): Promise<void> {
      return withStore("readwrite", "putMany", async (store) => {
        for (const [path, entry] of Object.entries(entries)) {
          const normalizedPath = normalizePath(path, "putMany");
          await putEntry(store, normalizedPath, entry, "putMany");
        }
      });
    },

    async deleteMany(paths: string[]): Promise<void> {
      return withStore("readwrite", "deleteMany", async (store) => {
        for (const path of paths) {
          const normalizedPath = normalizePath(path, "deleteMany");
          await store.delete(normalizedPath);
        }
      });
    },

    async forEachEntry(iterator: IDBFSEntryIterator): Promise<void> {
      return withStore("readonly", "forEachEntry", async (store) => {
        let cursor = await store.openCursor();
        while (cursor) {
          await iterator(String(cursor.key), decodeEntry(cursor.value, "forEachEntry"));
          cursor = await cursor.continue();
        }
      });
    },

    async exists(path: string): Promise<boolean> {
      const normalizedPath = normalizePath(path, "exists");
      return withStore("readonly", "exists", async (store) => {
        const key = await store.getKey(normalizedPath);
        return key !== undefined;
      });
    },

    async touch(path: string, timestamp: Date | number | string = new Date()): Promise<void> {
      const normalizedPath = normalizePath(path, "touch");
      return withStore("readwrite", "touch", async (store) => {
        const existing = await store.get(normalizedPath);
        if (existing === undefined) {
          await putEntry(
            store,
            normalizedPath,
            {
              timestamp,
              mode: makeRegularFileMode(),
              kind: "file",
              contents: new Uint8Array([]).buffer,
            },
            "touch",
          );
          return;
        }
        const decoded = decodeEntry(existing, "touch");
        await putEntry(
          store,
          normalizedPath,
          {
            timestamp,
            mode: decoded.mode,
            kind: decoded.kind,
            contents: decoded.contents,
          },
          "touch",
        );
      });
    },

    async close(): Promise<void> {
      if (!dbPromise) {
        return;
      }
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    },
  };

  return accessor;
}
