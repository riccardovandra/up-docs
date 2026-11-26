// Puts the design editor (the OpenPencil fork's static build) into dist/designer/.
// Runs after `vite build`, which empties dist/. Owner: S2.
//
// The build is pinned in designer.lock.json: { version, url, sha256 }. It is
// downloaded once into node_modules/.cache/up-docs-designer/, checked against
// the sha256, and unpacked. A tarball whose checksum differs is never used.
// DESIGNER_TARBALL=<path> uses a local tarball instead (for working on the
// editor before a release exists); its checksum is printed, not checked.
//
// No dependencies: Node or Bun, and the system `tar`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DesignerLock {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** The lock file's fields, or an error naming what is wrong. */
export function parseLock(text: string): DesignerLock {
  const value: unknown = JSON.parse(text);
  const fields = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const { version, url, sha256 } = fields;
  if (typeof version !== "string" || !version) throw new Error("designer.lock.json: no version");
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("designer.lock.json: url must be an https:// address");
  }
  if (typeof sha256 !== "string" || !HEX_SHA256.test(sha256)) {
    throw new Error("designer.lock.json: sha256 must be 64 lowercase hex characters");
  }
  return { version, url, sha256 };
}

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Throws unless the bytes hash to `expected`. */
export function verifySha256(bytes: Uint8Array, expected: string): void {
  const actual = sha256Of(bytes);
  if (actual !== expected) {
    throw new Error(`designer tarball checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Refuses a tarball that would write outside its folder or holds anything
 * but plain files and folders. `names` is `tar -tzf` output (one name per
 * line), `verboseListing` is `tar -tvzf` output (the type is each line's first character).
 */
export function checkEntries(names: string, verboseListing: string): void {
  for (const name of names.split("\n")) {
    if (!name) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`designer tarball: entry outside its folder: ${name}`);
    }
  }
  for (const line of verboseListing.split("\n")) {
    if (!line.trim()) continue;
    if (line[0] !== "-" && line[0] !== "d") {
      throw new Error(`designer tarball: not a plain file or folder: ${line}`);
    }
  }
}

async function download(lock: DesignerLock, cacheDir: string): Promise<string> {
  const cached = path.join(cacheDir, `${lock.sha256}.tar.gz`);
  if (fs.existsSync(cached)) {
    verifySha256(fs.readFileSync(cached), lock.sha256);
    return cached;
  }
  console.log(`designer: downloading ${lock.version}`);
  const response = await fetch(lock.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`designer: download failed, HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifySha256(bytes, lock.sha256);
  fs.mkdirSync(cacheDir, { recursive: true });
  const partial = `${cached}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, cached);
  return cached;
}

/** Unpacks the checked tarball into `outDir`, replacing what was there. */
export function unpack(tarball: string, outDir: string): void {
  checkEntries(
    execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }),
    execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" }),
  );
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", outDir]);
  if (!fs.existsSync(path.join(outDir, "index.html"))) {
    throw new Error("designer tarball: no index.html at its root");
  }
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(root, "dist", "designer");
  const override = process.env.DESIGNER_TARBALL?.trim();
  let tarball: string;
  if (override) {
    tarball = path.resolve(override);
    console.log(`designer: local tarball ${tarball} (sha256 ${sha256Of(fs.readFileSync(tarball))})`);
  } else {
    const lock = parseLock(fs.readFileSync(path.join(root, "designer.lock.json"), "utf8"));
    tarball = await download(lock, path.join(root, "node_modules", ".cache", "up-docs-designer"));
    console.log(`designer: ${lock.version} checked`);
  }
  unpack(tarball, outDir);
  console.log(`designer: unpacked into ${path.relative(root, outDir)}`);
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
