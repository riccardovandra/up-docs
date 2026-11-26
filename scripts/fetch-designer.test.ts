import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkEntries, parseLock, sha256Of, unpack, verifySha256 } from "./fetch-designer.ts";

const SHA = "a".repeat(64);
const temps: Array<string> = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designer-test-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetch-designer", () => {
  it("reads a pinned lock and refuses a malformed one", () => {
    expect(
      parseLock(
        JSON.stringify({ version: "up-docs-v1", url: "https://x.test/a.tar.gz", sha256: SHA }),
      ),
    ).toEqual({
      version: "up-docs-v1",
      url: "https://x.test/a.tar.gz",
      sha256: SHA,
    });
    expect(() =>
      parseLock(JSON.stringify({ version: "v", url: "http://x.test/a", sha256: SHA })),
    ).toThrow(/https/);
    expect(() =>
      parseLock(JSON.stringify({ version: "v", url: "https://x.test/a", sha256: "ABC" })),
    ).toThrow(/sha256/);
  });

  it("accepts only bytes whose sha256 matches the lock", () => {
    const bytes = new TextEncoder().encode("designer build");
    expect(() => verifySha256(bytes, sha256Of(bytes))).not.toThrow();
    expect(() => verifySha256(bytes, SHA)).toThrow(/checksum mismatch/);
    const tampered = new TextEncoder().encode("designer buile");
    expect(() => verifySha256(tampered, sha256Of(bytes))).toThrow(/checksum mismatch/);
  });

  it("refuses entries outside the folder and anything but files and folders", () => {
    expect(() =>
      checkEntries("index.html\nassets/a.js\n", "-rw-r--r-- x\ndrwxr-xr-x y\n"),
    ).not.toThrow();
    expect(() => checkEntries("../evil.sh\n", "-rw-r--r-- x\n")).toThrow(/outside/);
    expect(() => checkEntries("/etc/passwd\n", "-rw-r--r-- x\n")).toThrow(/outside/);
    expect(() => checkEntries("link\n", "lrwxr-xr-x link -> /etc\n")).toThrow(/plain/);
  });

  it("unpacks a tarball into the output folder, replacing what was there", () => {
    const source = tempDir();
    fs.writeFileSync(path.join(source, "index.html"), "<!doctype html>");
    fs.mkdirSync(path.join(source, "assets"));
    fs.writeFileSync(path.join(source, "assets", "main.js"), "main()");
    const tarball = path.join(tempDir(), "designer.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", source, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const out = path.join(tempDir(), "designer");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "stale.txt"), "old");
    unpack(tarball, out);
    expect(fs.readFileSync(path.join(out, "assets", "main.js"), "utf8")).toBe("main()");
    expect(fs.existsSync(path.join(out, "stale.txt"))).toBe(false);
  });
});
