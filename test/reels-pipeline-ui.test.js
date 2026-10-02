import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { initReelsPipeline } from "../public/reels-pipeline.js";
import { createReelsPipeline } from "../src/reels-pipeline.js";
import { fakeCreatorLab, sourceJob } from "../test-support/reels-pipeline.js";

class Element {
  constructor() { this.events = {}; this.children = []; this.value = ""; }
  addEventListener(name, fn) { this.events[name] = fn; }
  replaceChildren(...items) { this.children = items; }
  async fire(name) { return this.events[name]?.({ preventDefault() {} }); }
}

test("profile form starts only on submit, pauses, resumes and opens completed work without duplicate calls", async (t) => {
  const html = await readFile(new URL("../public/reels.html", import.meta.url), "utf8");
  const elements = new Map([...html.matchAll(/id="(analysis-[^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const el = (id) => elements.get(`analysis-${id}`);
  const lab = fakeCreatorLab(), imports = [], requests = [];
  const pipeline = createReelsPipeline({ env: { JEV_SOCIAL_CREATOR_LAB_URL: "http://127.0.0.1:5190" }, fetchImpl: lab.fetch, save: async () => ({ id: "reels-saved" }) });
  let poll;
  t.mock.method(globalThis, "setTimeout", (fn) => { poll = fn; return 1; });
  t.mock.method(globalThis, "clearTimeout", () => { poll = null; });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: (id) => elements.get(id), createElement: () => new Element() } });
  const location = { href: "http://127.0.0.1:8766/reels" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, history: { replaceState(_, __, url) { location.href = String(url); } } } });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, method: options?.method || "GET" });
    let payload;
    try {
      if (url === "/api/reels/pipeline") payload = await pipeline.status();
      else if (url === "/api/reels/jobs") payload = await pipeline.start(JSON.parse(options.body));
      else {
        const [id, action] = url.slice("/api/reels/jobs/".length).split("/");
        payload = action === "sync" ? await pipeline.sync(id) : action ? await pipeline.change(id, action) : await pipeline.read(id);
      }
      return { ok: true, json: async () => payload };
    } catch (error) { return { ok: false, json: async () => ({ error: { message: error.message } }) }; }
  });
  try {
    initReelsPipeline(async (id) => { imports.push(id); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(el("start").disabled, false);
    assert.equal(lab.jobs.size, 0, "opening the page does not start paid work");
    el("creator").value = "@example"; el("limit").value = "5"; el("budget").value = "0.1"; el("language").value = "en";
    await el("form").fire("submit");
    assert.equal(lab.jobs.size, 1);
    assert.match(el("stage").textContent, /Analyzing speech/);
    assert.equal(el("start").disabled, true);
    assert.equal(el("pause").hidden, false);
    await el("form").fire("submit");
    assert.equal(lab.jobs.size, 1, "an active job cannot be started twice");
    await el("pause").fire("click");
    assert.match(el("stage").textContent, /Paused/);
    assert.equal(el("resume").hidden, false);
    const source = lab.jobs.get("job-1"); source.posts = sourceJob().posts;
    await el("refresh").fire("click");
    assert.match(el("counts").textContent, /3 collected · 1 classified · 1 excluded · 1 failed/);
    await el("open").fire("click");
    assert.deepEqual(imports, ["reels-saved"]);
    await el("resume").fire("click");
    source.status = "partial";
    await poll();
    assert.match(el("stage").textContent, /Finished with some failures/);
    assert.deepEqual(imports, ["reels-saved", "reels-saved"]);
    assert.equal(el("start").disabled, false, "finishing releases the start button");
    await el("refresh").fire("click");
    assert.equal(imports.length, 2, "refreshing does not resubmit or import again");
    assert.equal(lab.calls.filter((call) => call.url.endsWith("/run")).length, 2, "only the explicit start and resume requests execute");
    assert.ok(requests.every((request) => request.url.startsWith("/api/reels/")));
    lab.missing = ["groq"];
    await el("refresh").fire("click");
    assert.equal(el("start").disabled, true);
    assert.match(el("connection").textContent, /Groq/);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
  }
});

test("a lost start response disables another start until a read-only refresh recovers the job", async () => {
  const html = await readFile(new URL("../public/reels.html", import.meta.url), "utf8");
  const elements = new Map([...html.matchAll(/id="(analysis-[^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const el = (id) => elements.get(`analysis-${id}`);
  const requests = [], job = { id: "job-1", creator: "example", status: "running", total: 0, classified: 0, excluded: 0, failed: 0, pending: 0, apifyUsd: null, canPause: true, canResume: false };
  let started = false;
  const context = {
    document: { getElementById: (id) => elements.get(id), createElement: () => new Element() },
    window: { location: { href: "http://127.0.0.1:8766/reels" }, history: { replaceState() {} } },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push([url, options?.method || "GET"]);
      if (options?.method === "POST") { started = true; throw new Error("private request diagnostics"); }
      return { ok: true, json: async () => url.endsWith("/pipeline") ? { available: true, ready: true, busy: started, jobs: started ? [job] : [], message: "Connected" } : job };
    },
  };
  initReelsPipeline(async () => {}, context);
  await new Promise((resolve) => setImmediate(resolve));
  el("creator").value = "example"; el("limit").value = "5"; el("budget").value = "0.1"; el("language").value = "en";
  await el("form").fire("submit");
  assert.equal(el("start").disabled, true);
  assert.match(el("error").textContent, /could not be confirmed/);
  assert.doesNotMatch(el("error").textContent, /private request/);
  await el("form").fire("submit");
  assert.equal(requests.filter(([, method]) => method === "POST").length, 1);
  await el("refresh").fire("click");
  assert.match(el("stage").textContent, /Analyzing speech/);
  assert.equal(el("pause").hidden, false);
  assert.equal(requests.filter(([, method]) => method === "POST").length, 1);
});
