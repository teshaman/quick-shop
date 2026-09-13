#!/usr/bin/env node
/**
 * Build a zip of the module for uploading to a hosted Foundry (The Forge's Import Wizard, a VPS).
 * Leaves out mcp/node_modules and build output. Run: npm run zip  (from the mcp/ folder)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, cpSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mcpDir = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(mcpDir, "..");
const manifest = JSON.parse(readFileSync(path.join(moduleDir, "module.json"), "utf8"));
const outDir = path.join(mcpDir, "dist");
const stage = path.join(mkdtempSync(path.join(os.tmpdir(), "quick-shop-zip-")), manifest.id);
const zip = path.join(outDir, `${manifest.id}-${manifest.version}.zip`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(stage, { recursive: true });
cpSync(moduleDir, stage, {
  recursive: true,
  filter: src => {
    const rel = path.relative(moduleDir, src).split(path.sep).join("/");
    return !rel.startsWith("mcp/node_modules") && !rel.startsWith("mcp/dist") && !rel.startsWith(".git");
  }
});
// bsdtar ships with Windows 10+, macOS, and most Linux distros; it writes forward-slash entries that every
// unzip implementation (including The Forge's importer) reads correctly, unlike PowerShell's Compress-Archive.
// On Windows call the system bsdtar by full path: a Git Bash PATH would otherwise pick GNU tar, which cannot
// write zips and reads "C:" as a remote host.
const tar = (process.platform === "win32") ? path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, ["-a", "-cf", path.basename(zip), "-C", path.dirname(stage), manifest.id], { cwd: outDir, stdio: "inherit" });
rmSync(path.dirname(stage), { recursive: true, force: true });
if ( !existsSync(zip) ) throw new Error("zip was not created");
console.log(`Built ${zip}`);
