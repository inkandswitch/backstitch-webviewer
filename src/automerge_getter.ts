import { serializeGodotSceneAsUint8Array } from "./godot_serializer";
// import zip library
import JSZip from "jszip";
const DOC_FETCH_URL = `/[api]/doc/[docId]`;
const TIMEOUT = 60000;

export async function getDoc(docId: string, api: string): Promise<any> {
  const url = DOC_FETCH_URL.replace("[docId]", docId).replace("[api]", api);
  console.log(`[getDoc] fetching ${url}`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    var doc = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    console.log(`[getDoc] response ${doc.status} for ${docId}`);
    var docJson = await doc.json();
    console.log(`[getDoc] parsed JSON for ${docId}`);
  } catch (e) {
    console.error("[getDoc] Error getting doc: ", docId, e);
    return null;
  }
  return docJson;
}

export async function getProjectMetadata(projectId: string): Promise<any> {
  const metadata = await getDoc(projectId);
  if (!metadata) throw new Error(`Could not load project "${projectId}"`);
  return metadata;
}

export async function getBranchFiles(branchId: string, onProgress?: (current: number, total: number) => void): Promise<Map<string, Uint8Array>> {
  var map = new Map<string, Uint8Array>();

  console.log(`[getBranchFiles] fetching branch doc ${branchId}`);
  var mainDoc = await getDoc(branchId);
  if (!mainDoc?.files) {
    throw new Error(`Could not load project data — the project may be empty or corrupted.`);
  }
  console.log(`[getBranchFiles] main doc has ${Object.keys(mainDoc.files).length} files`);

  const entries = Object.entries(mainDoc.files);
  console.log(`Processing ${entries.length} files`);

  // Process text and scene files immediately, collect binary fetches
  const pending: Promise<void>[] = [];
  let completed = 0;
  const CONCURRENCY = 10;
  let running = 0;

  // HACK: skip .exe files until the server stops including them
  const SKIP_EXTENSIONS = [".exe"];

  for (const [filename, fileData] of entries as [string, any][]) {
    if (SKIP_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
      completed++;
      onProgress?.(completed, entries.length);
      continue;
    }
    if (fileData.content) {
      map.set(filename, new TextEncoder().encode(fileData.content));
      completed++;
      onProgress?.(completed, entries.length);
    } else if (fileData.url) {
      const task = async () => {
        while (running >= CONCURRENCY) {
          await new Promise((r) => setTimeout(r, 50));
        }
        running++;
        try {
          const subDocId: string = fileData.url.split(":")[1];
          console.log(`[fetch] ${filename}`);
          const subDoc = await getDoc(subDocId);
          map.set(filename, new Uint8Array(subDoc.content));
        } finally {
          running--;
          completed++;
          onProgress?.(completed, entries.length);
        }
      };
      pending.push(task());
    } else if (fileData.structured_content) {
      map.set(filename, serializeGodotSceneAsUint8Array(fileData.structured_content));
      completed++;
      onProgress?.(completed, entries.length);
    }
  }

  await Promise.all(pending);
  console.log(`All ${entries.length} files processed`);
  return map;
}

// array of strings
export async function getLastHeads(docId: string, api: string): Promise<string[] | null> {
  const url = `/${api}/last_heads/${docId}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    var doc = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    console.log(`[getDoc] response ${doc.status} for ${docId}`);
    var docJson = await doc.json();
    console.log(`[getDoc] parsed JSON for ${docId}`);
  } catch (e) {
    console.error("[getDoc] Error getting doc: ", docId, e);
    return null;
  }
  return docJson as string[];
}

export async function getBranchFilesAsZip(branchId: string): Promise<ArrayBuffer> {
  var map = await getBranchFiles(branchId);
  return await zipBranchFiles(map);
}

export async function zipBranchFiles(map: Map<string, Uint8Array<ArrayBufferLike>>): Promise<ArrayBuffer> {
  var zip = new JSZip();
  for (const [filename, content] of map.entries()) {
    zip.file(filename.replace("res://", ""), content);
  }
  return (await zip.generateAsync({ type: "blob" })).arrayBuffer();
}
