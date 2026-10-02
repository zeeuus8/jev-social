import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { initReelsLibrary, readReelsFile } from "../public/reels-view.js";
import { MAX_REELS_BYTES } from "../src/reels-contract.js";
import { normalizeReels } from "../src/reels.js";

const html = await readFile(new URL("../public/reels.html", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("fixtures/reels-import-v1.json", import.meta.url), "utf8"));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.attributes = {}; this.value = ""; this.hidden = false; this.disabled = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return `${this.text || ""}${this.children.map((item) => item.textContent).join(" ")}`; }
  set innerHTML(_) { assert.fail("Imported content must be rendered as text"); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.text = ""; this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, callback) { this.events[event] = callback; }
  async fire(event) { return this.events[event]?.({ preventDefault() {} }); }
  querySelector(tag) { return this.children.find((item) => item.tag === tag); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  click() { this.clicked = true; }
}
function dom() {
  const elements = new Map([...html.matchAll(/<(\w+)[^>]*id="(reels-[^"]+)"/g)].map(([, tag, id]) => [id, new Element(tag)]));
  const el = (id) => elements.get(`reels-${id}`);
  const reset = () => { for (const [key, value] of Object.entries({ topic: "all", hook: "all", structure: "all", review: "all", confidence: "0" })) el(key).value = value; };
  reset(); el("filters").reset = reset; el("file").files = [];
  for (const id of ["content", "empty", "error", "retry"]) el(id).hidden = true;
  const window = { location: { href: "http://127.0.0.1:8766/reels" }, history: { replaceState(_state, _title, url) { window.location.href = String(url); } }, matchMedia: () => ({ matches: false }) };
  return { el, window, document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag) } };
}
const response = (body, ok = true) => ({ ok, json: async () => structuredClone(body) });
const listing = (collections) => ({ collections: collections.map((item) => ({ id: item.id, sourceId: item.sourceId, creator: item.creator, itemCount: item.posts.length })) });
function sample(id = "ui-snapshot") {
  const raw = structuredClone(fixture); raw.id = id;
  raw.posts = Array.from({ length: 13 }, (_, index) => ({ ...structuredClone(fixture.posts[0]), id: `item-${String(index).padStart(3, "0")}`, url: `https://instagram.com/p/Fixture${index}/` }));
  raw.posts[0].transcript.text = "<img src=x onerror=alert(1)> Source text";
  raw.posts[1].analysis.labels.mechanism.confidence = 0.5;
  raw.posts[11].analysis = null; raw.posts[11].status = "failed"; raw.posts[11].transcript = null;
  raw.posts[12].analysis = null; raw.posts[12].status = "no_audio"; raw.posts[12].transcript = null;
  return normalizeReels(raw);
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("library renders safe text, nullable metrics, timestamps, states and keyboard-focusable details", async () => {
  const ui = dom(), saved = sample(), requests = [];
  await initReelsLibrary({ ...ui, fetch: async (url, options) => { requests.push([url, options]); return response(url === "/api/reels" ? listing([saved]) : saved); } });
  const { el } = ui;
  assert.equal(el("content").hidden, false);
  assert.equal(el("cards").children.length, 12);
  assert.equal(el("match-count").textContent, "13 of 13 Reels");
  assert.match(el("detail").textContent, /<img src=x onerror=alert\(1\)> Source text/);
  assert.match(el("detail").textContent, /Unknown views/);
  assert.match(el("detail").textContent, /0 comments/);
  assert.match(el("detail").textContent, /0:00–0:02/);
  assert.equal(el("detail").querySelector("a").href, "https://www.instagram.com/p/Fixture0/");
  assert.equal(el("detail").querySelector("a").rel, "noopener noreferrer");
  assert.match(ui.window.location.href, new RegExp(saved.id));
  await el("cards").children[1].fire("click");
  assert.equal(el("detail").querySelector("h3").focused, true);
  assert.match(el("detail").textContent, /Review suggested/);
  await el("next").fire("click");
  assert.equal(el("cards").children.length, 1);
  assert.equal(el("page").textContent, "13–13 of 13");
  assert.equal(el("next").disabled, true);
  assert.match(el("detail").textContent, /No audio track/);
  for (const [review, expected] of [["review", "1"], ["error", "1"], ["excluded", "1"], ["unclassified", "0"]]) {
    el("review").value = review; await el("filters").fire("change");
    assert.equal(el("match-count").textContent, `${expected} of 13 Reels`);
  }
  assert.match(el("cards").textContent, /No Reels match/);
  assert.doesNotMatch(el("detail").textContent, /Source text/);
  await el("reset").fire("click");
  el("confidence").value = "0.65"; await el("filters").fire("change");
  assert.equal(el("match-count").textContent, "10 of 13 Reels");
  assert.equal(requests.length, 2, "filtering and reading do not fetch providers or media");
  assert.ok(requests.every(([url, options]) => url.startsWith("/api/reels") && !options?.method));
});

test("file validation rejects unreadable, oversized, malformed and unversioned exports before upload", async () => {
  await assert.rejects(readReelsFile({ size: MAX_REELS_BYTES + 1, text() { assert.fail("oversized file must not be read"); } }), /10 MB/);
  await assert.rejects(readReelsFile({ size: 0, text: async () => "é".repeat(MAX_REELS_BYTES / 2 + 1) }), /10 MB/);
  await assert.rejects(readReelsFile({ size: 1, text: async () => { throw new Error("/Users/private"); } }), /could not be read/);
  await assert.rejects(readReelsFile({ size: 1, text: async () => "{" }), /not valid JSON/);
  for (const value of [null, {}, { schemaVersion: 2 }]) await assert.rejects(readReelsFile({ size: 2, text: async () => JSON.stringify(value) }), /version 1/);
  assert.deepEqual(await readReelsFile({ size: 100, text: async () => JSON.stringify(fixture) }), fixture);
});

test("import failures preserve the loaded collection and show safe errors; repeated import remains one collection", async () => {
  const ui = dom(), saved = sample(), imported = { ...saved, posts: saved.posts.slice(0, 2) }, uploads = [];
  let fail = true;
  await initReelsLibrary({ ...ui, fetch: async (url, options) => {
    if (options?.method === "POST") {
      uploads.push(options);
      return fail ? response({ error: { code: "REELS_SAVE_FAILED", message: "private path /Users/private" } }, false) : response(imported);
    }
    return response(url === "/api/reels" ? listing([saved]) : saved);
  } });
  const { el } = ui;
  el("file").files = [{ size: 1, text: async () => "{" }]; await el("file").fire("change");
  assert.equal(uploads.length, 0);
  assert.equal(el("content").hidden, false);
  assert.match(el("error").textContent, /not valid JSON/);
  el("file").files = [{ name: "renamed.json", size: 100, text: async () => JSON.stringify(fixture) }]; await el("file").fire("change");
  assert.equal(uploads.length, 1);
  assert.match(el("error").textContent, /could not be saved/);
  assert.doesNotMatch(el("error").textContent, /private/);
  assert.equal(el("match-count").textContent, "13 of 13 Reels");
  assert.equal(el("import-button").disabled, false);
  assert.equal(el("file").value, "");
  fail = false; await el("file").fire("change");
  assert.equal(el("match-count").textContent, "2 of 2 Reels");
  assert.equal(el("collection").children.length, 1);
  assert.equal(el("collection").disabled, false);
  assert.equal(el("error").hidden, true);
  assert.deepEqual(JSON.parse(uploads[1].body), fixture);
});

test("empty and disconnected libraries offer recovery without claiming existing data or making paid requests", async () => {
  const ui = dom(); let available = false;
  await initReelsLibrary({ ...ui, fetch: async (url) => {
    assert.equal(url, "/api/reels");
    if (!available) throw new Error("network /Users/private");
    return response({ collections: [] });
  } });
  assert.equal(ui.el("retry").hidden, false);
  assert.equal(ui.el("empty").hidden, true);
  assert.match(ui.el("error").textContent, /Cannot reach/);
  available = true; await ui.el("retry").fire("click");
  assert.equal(ui.el("empty").hidden, false);
  assert.equal(ui.el("collection").disabled, true);
  assert.equal(ui.el("content").hidden, true);
  await ui.el("empty-import").fire("click");
  assert.equal(ui.el("file").clicked, true);
});

test("late collection responses cannot overwrite a newer selection or a successful import", async () => {
  const ui = dom(), first = sample(), second = sample("second"), third = sample("third");
  const slow = deferred(); let delay = false, uploads = 0;
  await initReelsLibrary({ ...ui, fetch: async (url, options) => {
    if (options?.method === "POST") { uploads++; return response(third); }
    if (url === "/api/reels") return response(listing([first, second]));
    if (url.endsWith(second.id)) return response(second);
    return delay ? slow.promise : response(first);
  } });
  delay = true;
  ui.el("collection").value = first.id; const pending = ui.el("collection").fire("change");
  ui.el("collection").value = second.id; await ui.el("collection").fire("change");
  assert.match(ui.window.location.href, new RegExp(second.id));
  const file = deferred(); ui.el("file").files = [{ size: 100, text: () => file.promise }];
  const upload = ui.el("file").fire("change");
  assert.equal(ui.el("collection").disabled, true);
  assert.equal(ui.el("import-button").disabled, true);
  await ui.el("file").fire("change");
  file.resolve(JSON.stringify(fixture)); await upload;
  slow.resolve(response(first)); await pending;
  assert.equal(uploads, 1);
  assert.equal(ui.el("collection").value, third.id);
  assert.match(ui.window.location.href, new RegExp(third.id));
});

test("a failed selection preserves the previous snapshot and unsafe source links are never clickable", async () => {
  const ui = dom(), first = sample(), second = sample("second");
  first.posts[0].url = "javascript:alert(1)";
  await initReelsLibrary({ ...ui, fetch: async (url) => {
    if (url === "/api/reels") return response(listing([first, second]));
    if (url.endsWith(second.id)) return response({ error: { code: "REELS_NOT_FOUND" } }, false);
    return response(first);
  } });
  assert.equal(ui.el("detail").querySelector("a"), undefined);
  ui.el("collection").value = second.id; await ui.el("collection").fire("change");
  assert.equal(ui.el("content").hidden, false);
  assert.equal(ui.el("collection").value, first.id);
  assert.match(ui.el("message").textContent, /last loaded collection/);
  assert.match(ui.el("error").textContent, /unavailable/);
  assert.equal(ui.el("retry").hidden, false);
});

test("a failed import during a collection switch restores the displayed collection selector", async () => {
  const ui = dom(), first = sample(), second = sample("second"), pending = deferred();
  await initReelsLibrary({ ...ui, fetch: async (url) => {
    if (url === "/api/reels") return response(listing([first, second]));
    return url.endsWith(second.id) ? pending.promise : response(first);
  } });
  ui.el("collection").value = second.id; const switching = ui.el("collection").fire("change");
  ui.el("file").files = [{ size: 1, text: async () => "{" }]; await ui.el("file").fire("change");
  pending.resolve(response(second)); await switching;
  assert.equal(ui.el("collection").value, first.id);
  assert.equal(ui.el("content").hidden, false);
  assert.doesNotMatch(ui.el("message").textContent, /Loading collection/);
  assert.match(ui.el("message").textContent, /last loaded collection/);
});
