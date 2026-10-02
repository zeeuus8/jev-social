import { LABEL_VALUES } from "../src/reels-contract.js";

export const labToken = "a".repeat(64);
export function sourceJob(id = "job-1") {
  return { id, schemaVersion: "script-anatomy-v1", creator: "example", status: "partial", language: "", createdAt: "2026-10-01T00:00:00Z", limit: 3, budget: 0.25, costs: { apify: 0.01 }, posts: [
    { id: "one", status: "complete", url: "https://instagram.com/reel/one/", plays: 1000, transcript: { text: "Make one useful thing and show how it works.", raw: { secret: "private-transcript-payload" } },
      analysis: { labels: Object.fromEntries(Object.entries(LABEL_VALUES).map(([key, values]) => [key, { value: values[0], confidence: 0.9 }])), anatomy: [], raw: { apiKey: "provider-secret" } } },
    { id: "two", url: "https://instagram.com/reel/two/", status: "no_audio", excludedReason: "no audio" },
    { id: "three", url: "https://instagram.com/reel/three/", status: "failed", error: "/Users/private/media.flac" },
  ], error: "api_key=do-not-expose", events: [{ message: "/private/tmp/secret" }] };
}

export function fakeCreatorLab(initial = []) {
  const jobs = new Map(initial.map((job) => [job.id, structuredClone(job)])), calls = [];
  const lab = {
    jobs, calls, missing: [],
    async fetch(url, options = {}) {
      const route = new URL(url).pathname;
      calls.push({ url, ...options });
      const respond = (data, status = 200) => new Response(JSON.stringify(data), { status });
      if (route === "/api/bootstrap") return respond({ token: labToken, version: "script-anatomy-v1", transcriptionProvider: "groq",
        connections: Object.fromEntries(["apify", "groq", "jev"].map((key) => [key, { configured: !lab.missing.includes(key) }])),
        runs: [...jobs.values()].map((job) => ({ id: job.id, creator: job.creator, status: job.status, createdAt: job.createdAt, count: job.posts.length, completed: job.posts.filter((p) => p.analysis).length })) });
      if (route === "/api/runs" && options.method === "POST") {
        const settings = JSON.parse(options.body);
        const job = { ...sourceJob(`job-${jobs.size + 1}`), ...settings, status: "ready", posts: [], error: null };
        jobs.set(job.id, job); return respond(job, 201);
      }
      const match = route.match(/^\/api\/runs\/([\w-]+)(?:\/(run|pause))?$/);
      const job = jobs.get(match?.[1]);
      if (!job) return respond({ error: "private missing path" }, 404);
      if (match[2] === "run") { job.status = "running"; job.pauseRequested = false; }
      if (match[2] === "pause") { job.status = "paused"; job.pauseRequested = true; }
      return respond(job);
    },
  };
  return lab;
}
