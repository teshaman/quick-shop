/**
 * Smoke test: starts the MCP server on a spare port, connects a fake Foundry client that echoes
 * requests, then drives the server over stdio with real MCP JSON-RPC messages.
 * Run: node test/smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 30399;

const child = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, QUICK_SHOP_PORT: String(PORT), QUICK_SHOP_TOKEN: "secret" },
  stdio: ["pipe", "pipe", "inherit"]
});

let buffer = "";
const replies = new Map();
child.stdout.on("data", chunk => {
  buffer += chunk.toString();
  let idx;
  while ( (idx = buffer.indexOf("\n")) >= 0 ) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if ( !line ) continue;
    const msg = JSON.parse(line);
    if ( msg.id !== undefined && replies.has(msg.id) ) replies.get(msg.id)(msg);
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise(resolve => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function fail(msg) { console.error("FAIL:", msg); child.kill(); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 1. MCP handshake.
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
if ( init.result?.serverInfo?.name !== "quick-shop" ) fail("initialize did not return the quick-shop server");
notify("notifications/initialized", {});

const list = await rpc("tools/list", {});
const names = list.result.tools.map(t => t.name);
console.log(`tools: ${names.length}`, names.join(", "));
if ( !names.includes("list_shops") ) fail("list_shops tool missing");

// 2. Calling a tool before Foundry connects must produce a helpful error, not a crash.
const early = await rpc("tools/call", { name: "list_shops", arguments: {} });
if ( !early.result?.isError || !/not connected/i.test(early.result.content[0].text) ) fail("expected a not-connected error");
console.log("not-connected error OK");

// 3. A client with a wrong token is rejected.
await sleep(300);
const bad = new WebSocket(`ws://localhost:${PORT}`);
await new Promise(r => bad.on("open", r));
bad.send(JSON.stringify({ type: "hello", module: "quick-shop", token: "wrong", worldTitle: "Bad", user: "x" }));
const badClose = await new Promise(r => bad.on("close", code => r(code)));
if ( badClose !== 4001 ) fail(`bad token should close with 4001, got ${badClose}`);
console.log("bad token rejected OK");

// 4. Fake Foundry client that answers requests.
const ws = new WebSocket(`ws://localhost:${PORT}`);
await new Promise(r => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", module: "quick-shop", token: "secret", worldTitle: "Smoke World", user: "Gamemaster", system: "dnd5e" }));
ws.on("message", raw => {
  const msg = JSON.parse(raw.toString());
  if ( msg.type !== "request" ) return;
  if ( msg.action === "listShops" ) {
    ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: [{ id: "abc", name: "The Rusty Anvil", open: true }] }));
  } else if ( msg.action === "buy" ) {
    ws.send(JSON.stringify({ type: "response", id: msg.id, ok: false, error: `Insufficient funds for ${msg.params.item}` }));
  } else {
    ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { echo: msg } }));
  }
});
await sleep(200);

const shops = await rpc("tools/call", { name: "list_shops", arguments: {} });
if ( shops.result?.isError ) fail(`list_shops errored: ${shops.result.content[0].text}`);
if ( !/Rusty Anvil/.test(shops.result.content[0].text) ) fail("list_shops did not round-trip");
console.log("list_shops round-trip OK");

const buy = await rpc("tools/call", { name: "buy_item", arguments: { shop: "The Rusty Anvil", buyer: "Vex", item: "Longsword" } });
if ( !buy.result?.isError || !/Insufficient funds for Longsword/.test(buy.result.content[0].text) ) fail("buy_item error not forwarded");
console.log("Foundry error forwarded OK");

const gen = await rpc("tools/call", { name: "generate_stock", arguments: { shop: "abc", count: 5, category: "weapon", replace: true } });
const echoed = JSON.parse(gen.result.content[0].text).echo;
if ( echoed.action !== "generateStock" || echoed.params.count !== 5 || echoed.params.replace !== true ) fail("generate_stock args not forwarded");
console.log("generate_stock args forwarded OK");

const invalid = await rpc("tools/call", { name: "set_shop_open", arguments: { shop: "abc", open: "yes" } });
if ( !invalid.error && !invalid.result?.isError ) fail("invalid arguments should be rejected");
console.log("schema validation OK");

console.log("ALL OK");
ws.close();
child.kill();
process.exit(0);
