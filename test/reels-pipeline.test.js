import assert from "node:assert/strict";
import test from "node:test";
import { adaptCreatorLabJob, createReelsPipeline, pipelineOrigin, validateAnalysisInput } from "../src/reels-pipeline.js";
import { normalizeReels } from "../src/reels.js";
import { fakeCreatorLab, labToken, sourceJob } from "../test-support/reels-pipeline.js";

const env = { JEV_SOCIAL_CREATOR_LAB_URL: "http://127.0.0.1:5190", OPENROUTER_API_KEY: "never-forward-this-key" };
const adapter = (lab, options = {}) => createReelsPipeline({ env, fetchImpl: lab.fetch, ...options });

test("pipeline configuration accepts only explicit numeric loopback origins", () => {
  assert.equal(pipelineOrigin({}), null);
  assert.equal(pipelineOrigin(env), "http://127.0.0.1:5190");
  for (const url of ["https://127.0.0.1:5190", "http://localhost:5190", "http://example.com:5190", "http://user:pass@127.0.0.1:5190", "http://127.0.0.1:5190/path", "http://127.0.0.1:5190?key=private", "http://127.0.0.1:5190#x"]) {
    assert.throws(() => pipelineOrigin({ JEV_SOCIAL_CREATOR_LAB_URL: url }), /configuration is invalid/);
  }
});

test("analysis settings normalize handles and reject unbounded or injected settings", () => {
  assert.deepEqual(validateAnalysisInput({ creator: " @Hormozi " }), { creator: "hormozi", limit: 20, budget: 0.25, language: "", concurrency: 2 });
  for (const body of [null, [], { creator: "https://instagram.com/hormozi" }, { creator: "../config" }, { creator: "a..b" }, { creator: "@ok", limit: "20" }, { creator: "ok", limit: 101 }, { creator: "ok", budget: 0.01 }, { creator: "ok", budget: Infinity }, { creator: "ok", language: "arbitrary" }, { creator: "ok", rows: [] }, { creator: "ok", concurrency: 50 }]) {
    assert.throws(() => validateAnalysisInput(body), { code: "INVALID_REELS_ANALYSIS" });
  }
});

test("status and saved job reads never start provider work or expose raw diagnostics", async () => {
  const lab = fakeCreatorLab([sourceJob()]), pipeline = adapter(lab);
  const status = await pipeline.status();
  assert.equal(status.ready, true);
  const job = await pipeline.read("job-1");
  assert.deepEqual([job.total, job.classified, job.excluded, job.failed, job.pending], [3, 1, 1, 1, 0]);
  assert.equal(job.status, "partial");
  assert.equal(job.canResume, true);
  assert.doesNotMatch(JSON.stringify({ status, job }), /provider-secret|private-transcript|api_key|private\/|token|never-forward/);
  assert.ok(lab.calls.every((call) => call.method === "GET"));
  assert.ok(lab.calls.every((call) => call.redirect === "error" && !call.headers.Authorization));
});

test("start creates a bounded job and sends its token only to the configured local service", async () => {
  const lab = fakeCreatorLab(), pipeline = adapter(lab);
  const job = await pipeline.start({ creator: "@example", limit: 5, budget: 0.1, language: "en" });
  assert.equal(job.status, "running");
  const mutations = lab.calls.filter((call) => call.method === "POST");
  assert.equal(mutations.length, 2);
  assert.deepEqual(JSON.parse(mutations[0].body), { creator: "example", limit: 5, budget: 0.1, language: "en", concurrency: 2 });
  assert.ok(mutations.every((call) => call.headers["X-Lab-Token"] === labToken && call.headers.Origin === "http://127.0.0.1:5190"));
  assert.doesNotMatch(JSON.stringify(lab.calls), /never-forward-this-key/);
  await assert.rejects(pipeline.start({ creator: "other" }), { code: "REELS_PIPELINE_BUSY" });
  assert.equal(lab.jobs.size, 1);
});

test("concurrent starts and missing provider configuration do not launch duplicates", async () => {
  const lab = fakeCreatorLab(), pipeline = adapter(lab);
  const first = pipeline.start({ creator: "example" });
  await assert.rejects(pipeline.start({ creator: "example" }), { code: "REELS_PIPELINE_BUSY" });
  await first;
  assert.equal(lab.jobs.size, 1);
  const missing = fakeCreatorLab(); missing.missing = ["groq"];
  assert.deepEqual((await adapter(missing).status()).missing, ["groq"]);
  await assert.rejects(adapter(missing).start({ creator: "example" }), { code: "REELS_PROVIDERS_MISSING" });
  assert.equal(missing.jobs.size, 0);
});

test("a lost paid-start response remains recoverable and is never automatically retried", async () => {
  const lab = fakeCreatorLab();
  const pipeline = adapter(lab, { fetchImpl: async (url, options) => {
    const result = await lab.fetch(url, options);
    if (url.endsWith("/run")) throw new Error("connection lost /Users/private/path");
    return result;
  } });
  const job = await pipeline.start({ creator: "example" });
  assert.equal(job.status, "unknown");
  assert.equal(job.canResume, false);
  assert.match(job.message, /do not create a replacement/);
  assert.equal((await pipeline.read(job.id)).status, "running");
  assert.equal(lab.calls.filter((call) => call.url.endsWith("/run")).length, 1);
});

test("pause and resume use the saved job, preserve partial results, and block uncertain collection", async () => {
  const raw = sourceJob(); raw.status = "running";
  const lab = fakeCreatorLab([raw]), pipeline = adapter(lab);
  assert.equal((await pipeline.change(raw.id, "pause")).status, "paused");
  assert.equal((await pipeline.change(raw.id, "resume")).status, "running");
  assert.equal(lab.jobs.size, 1);
  assert.equal(lab.jobs.get(raw.id).posts.length, 3);
  lab.jobs.get(raw.id).status = "failed"; lab.jobs.get(raw.id).scrapeUncertain = true;
  const uncertain = await pipeline.read(raw.id);
  assert.equal(uncertain.canResume, false);
  await assert.rejects(pipeline.change(raw.id, "resume"), { code: "REELS_JOB_NOT_RESUMABLE" });
  assert.throws(() => pipeline.change(raw.id, "delete"), { code: "INVALID_REELS_ACTION" });
  await assert.rejects(pipeline.read("../../config"), { code: "INVALID_REELS_JOB" });
});

test("saving partial results uses the sanitized library importer and empty jobs remain empty", async () => {
  const lab = fakeCreatorLab([sourceJob()]); let saved;
  const pipeline = adapter(lab, { save: async (raw) => { saved = raw; return { id: "reels-imported" }; } });
  assert.deepEqual(await pipeline.sync("job-1"), { collectionId: "reels-imported" });
  assert.equal(saved.status, "partial");
  lab.jobs.get("job-1").posts = [];
  await assert.rejects(pipeline.sync("job-1"), { code: "REELS_RESULTS_EMPTY" });
});

test("service failures, incompatible responses, redirects and oversized data fail visibly", async () => {
  const offline = createReelsPipeline({ env, fetchImpl: async () => { throw new Error("private key or path"); } });
  assert.equal((await offline.status()).available, false);
  assert.doesNotMatch(JSON.stringify(await offline.status()), /private key or path/);
  const incompatible = createReelsPipeline({ env, fetchImpl: async () => new Response("{}") });
  assert.equal((await incompatible.status()).available, false);
  const large = createReelsPipeline({ env, fetchImpl: async () => new Response(" ".repeat(10_000_001)) });
  assert.match((await large.status()).message, /exceeds/);
  const redirect = createReelsPipeline({ env, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "https://untrusted.test" } }) });
  assert.equal((await redirect.status()).available, false);
});

test("the explicit Creator Lab adapter preserves IDs and maps pending, excluded and error states to v1", () => {
  const raw = sourceJob();
  raw.posts.push(...["queued", "transcribing", "transcribed", "classifying"].map((status, index) => ({ id: `pending-${index}`, url: `https://instagram.com/p/Pending${index}/`, status, plays: null, views: 0 })));
  raw.posts[1].analysis = raw.posts[0].analysis;
  const mapped = adaptCreatorLabJob(raw), result = normalizeReels(mapped);
  assert.equal(mapped.schemaVersion, 1);
  assert.equal(result.sourceId, raw.id);
  assert.equal(result.posts.find((post) => post.id === "one").status, "classified");
  assert.equal(result.posts.find((post) => post.id === "two").status, "excluded");
  assert.equal(result.posts.find((post) => post.id === "two").analysis, null);
  assert.equal(result.posts.find((post) => post.id === "three").status, "error");
  for (const post of result.posts.filter((post) => post.id.startsWith("pending-"))) {
    assert.equal(post.status, "unclassified"); assert.equal(post.views, 0); assert.equal(post.plays, null);
  }
  assert.doesNotMatch(JSON.stringify(result), /provider-secret|private-transcript|private\/|token/);
  for (const version of [undefined, 1, "future"]) assert.throws(() => adaptCreatorLabJob({ ...raw, schemaVersion: version }), { code: "INVALID_REELS_JOB" });
});

test("unsafe result URLs and unknown item states fail before any snapshot is saved", async () => {
  for (const mutate of [(raw) => raw.posts[0].url = "https://evil.test/private", (raw) => raw.posts[0].status = "invented", (raw) => delete raw.posts[0].id]) {
    const raw = sourceJob(); mutate(raw);
    const pipeline = adapter(fakeCreatorLab([raw]), { save: () => { assert.fail("invalid source must not reach persistence"); } });
    await assert.rejects(pipeline.read(raw.id), { code: "INVALID_REELS_JOB", status: 502 });
    await assert.rejects(pipeline.sync(raw.id), { code: "INVALID_REELS_JOB", status: 502 });
  }
});

test("saved jobs outside the UI bounds stay readable but cannot be resumed", async () => {
  for (const settings of [{ limit: 101 }, { budget: 31 }, { language: "unsupported" }]) {
    const lab = fakeCreatorLab([{ ...sourceJob(), ...settings }]), pipeline = adapter(lab);
    const job = await pipeline.read("job-1");
    assert.equal(job.total, 3);
    assert.equal(job.canResume, false);
    await assert.rejects(pipeline.change("job-1", "resume"), { code: "REELS_JOB_NOT_RESUMABLE" });
    assert.ok(lab.calls.every((call) => call.method === "GET"));
  }
});

test("changed settings or job identities never start the wrong saved analysis", async () => {
  const lab = fakeCreatorLab();
  const pipeline = adapter(lab, { fetchImpl: async (url, options) => {
    const result = await lab.fetch(url, options);
    if (url.endsWith("/api/runs") && options.method === "POST") return new Response(JSON.stringify({ ...await result.json(), limit: 100 }));
    return result;
  } });
  await assert.rejects(pipeline.start({ creator: "example", limit: 5 }), { code: "INVALID_REELS_JOB" });
  assert.equal(lab.calls.filter((call) => call.url.endsWith("/run")).length, 0);
  const wrongId = adapter(lab, { fetchImpl: async () => new Response(JSON.stringify(sourceJob("other-job"))) });
  await assert.rejects(wrongId.read("job-1"), { code: "INVALID_REELS_JOB" });
  await assert.rejects(wrongId.sync("job-1"), { code: "INVALID_REELS_JOB" });
});

test("unknown jobs block another start, and a lost create response only leaves an unstarted saved job", async () => {
  const uncertain = fakeCreatorLab([{ ...sourceJob(), status: "unexpected" }]);
  assert.equal((await adapter(uncertain).status()).busy, true);
  await assert.rejects(adapter(uncertain).start({ creator: "example" }), { code: "REELS_PIPELINE_BUSY" });
  const lab = fakeCreatorLab(), pipeline = adapter(lab, { fetchImpl: async (url, options) => {
    const result = await lab.fetch(url, options);
    if (url.endsWith("/api/runs") && options.method === "POST") throw new Error("lost create response");
    return result;
  } });
  await assert.rejects(pipeline.start({ creator: "example" }));
  assert.equal((await pipeline.status()).jobs[0].status, "ready");
  assert.equal(lab.calls.filter((call) => call.url.endsWith("/run")).length, 0);
});

test("a service token remains bound to the configured origin even if the environment changes", async () => {
  const localEnv = { ...env }, lab = fakeCreatorLab();
  const pipeline = createReelsPipeline({ env: localEnv, fetchImpl: async (url, options) => {
    const response = await lab.fetch(url, options);
    localEnv.JEV_SOCIAL_CREATOR_LAB_URL = "http://127.0.0.1:7777";
    return response;
  } });
  await pipeline.start({ creator: "example" });
  assert.ok(lab.calls.every((call) => new URL(call.url).origin === env.JEV_SOCIAL_CREATOR_LAB_URL));
});
