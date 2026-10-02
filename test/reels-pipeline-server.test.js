import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";
import { fakeCreatorLab, labToken, sourceJob } from "../test-support/reels-pipeline.js";

test("analysis HTTP routes protect mutations and persist sanitized partial results", async () => {
  const lab = fakeCreatorLab([sourceJob()]);
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.method === "POST" && req.headers["x-lab-token"] !== labToken) { res.writeHead(403); res.end("{}"); return; }
    const result = await lab.fetch(`http://${req.headers.host}${req.url}`, { method: req.method, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(result.status, { "Content-Type": "application/json" }); res.end(await result.text());
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-analysis-api-"));
  const { server, url } = await startServer({ port: 0, open: false, env: { JEV_SOCIAL_HOME: directory, JEV_SOCIAL_CREATOR_LAB_URL: `http://127.0.0.1:${upstream.address().port}` } });
  const post = (route, body = {}, origin = url) => fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  try {
    const status = await (await fetch(`${url}/api/reels/pipeline`)).json();
    assert.equal(status.ready, true);
    assert.doesNotMatch(JSON.stringify(status), /token|provider-secret/);
    assert.equal((await post("/api/reels/jobs", { creator: "example" }, "https://evil.test")).status, 403);
    assert.equal((await post("/api/reels/jobs", { creator: "example", rows: [] })).status, 400);
    assert.equal((await post("/api/reels/jobs/job-1/resume", { concurrency: 50 })).status, 400);
    assert.equal((await post("/api/reels/jobs/job-1/sync", {}, "https://evil.test")).status, 403);
    const sync = await post("/api/reels/jobs/job-1/sync");
    assert.equal(sync.status, 200);
    const { collectionId } = await sync.json();
    const collection = await (await fetch(`${url}/api/reels/${collectionId}`)).json();
    assert.equal(collection.sourceStatus, "partial");
    assert.equal(collection.posts.length, 3);
    assert.equal(collection.schemaVersion, 1);
    assert.deepEqual(collection.posts.map((post) => post.id), ["one", "three", "two"]);
    assert.equal(collection.posts[1].status, "error");
    const repeated = await post("/api/reels/jobs/job-1/sync");
    assert.equal((await repeated.json()).collectionId, collectionId);
    assert.equal((await (await fetch(`${url}/api/reels`)).json()).collections.length, 1);
    assert.doesNotMatch(JSON.stringify(collection), /provider-secret|private-transcript|do-not-expose|\/Users|\/private/);
    assert.equal((await fetch(`${url}/api/reels/jobs/missing`)).status, 404);
    const started = await post("/api/reels/jobs", { creator: "second", limit: 2, budget: 0.1 });
    assert.equal(started.status, 202);
    const job = await started.json();
    assert.equal(job.status, "running");
    assert.equal((await post(`/api/reels/jobs/${job.id}/pause`)).status, 200);
    assert.equal((await post(`/api/reels/jobs/${job.id}/resume`)).status, 200);
    assert.equal((await fetch(`${url}/reels-pipeline.js`)).status, 200);
  } finally {
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  }
});
