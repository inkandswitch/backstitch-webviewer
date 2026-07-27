// Read-only share links carry an obfuscated "<projectId>|<branchId>" payload in
// the "share" query param. This is obfuscation, not security: the decode function
// ships in the bundle, so a motivated viewer can recover the real ids. The goal
// is only to keep raw doc ids out of address bars, screenshots, and chat logs.

export type ShareToken = {
  projectId: string;
  branchId: string;
};

export function encodeShareToken(projectId: string, branchId: string): string {
  return obfuscate(`${projectId}|${branchId}`);
}

export function decodeShareToken(token: string): ShareToken | null {
  const decoded = deobfuscate(token);
  if (!decoded) return null;
  const [projectId, branchId] = decoded.split("|");
  if (!projectId || !branchId) return null;
  return { projectId, branchId };
}

// XOR with a position-dependent key byte; self-inverse, so the same
// transform both scrambles and restores.
function obfuscate(payload: string): string {
  const bytes = new TextEncoder().encode(payload);
  return toHex(bytes.map((b, i) => b ^ keyByte(i)));
}

function deobfuscate(token: string): string | null {
  try {
    const bytes = fromHex(token);
    return new TextDecoder().decode(bytes.map((b, i) => b ^ keyByte(i)));
  } catch {
    return null;
  }
}

const keyByte = (i: number) => (i * 37 + 113) & 0xff;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(s: string): Uint8Array {
  // parseInt is too forgiving; reject anything that isn't clean hex so
  // malformed tokens fail decoding instead of producing garbage ids.
  if (s.length % 2 !== 0 || /[^0-9a-f]/.test(s)) throw new Error("invalid hex");
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
