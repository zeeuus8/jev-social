import { AppError } from "./errors.js";
import { importReels, normalizeReels } from "./reels.js";
import { MAX_REELS_BYTES, knownMetric } from "./reels-contract.js";

const JOB_ID = /^[a-zA-Z0-9_-]{1,90}$/;
const ACTIVE = new Set(["running", "scraping"]);
const CREATOR_LAB_VERSION = "script-anatomy-v1";
const RESUMABLE = new Set(["ready", "paused", "interrupted", "partial", "failed"]);
const STATES = new Set([...ACTIVE, ...RESUMABLE, "complete"]);
const fail = (message, code = "REELS_PIPELINE_UNAVAILABLE", status = 503) => new AppError(message, { code, status });
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const money = (value) => knownMetric(value) ? value : null;

export function adaptCreatorLabJob(raw) {
  if (!record(raw) || raw.schemaVersion !== CREATOR_LAB_VERSION || !Array.isArray(raw.posts) || raw.posts.length > 1000) throw fail("The analysis service returned an unsupported export.", "INVALID_REELS_JOB", 502);
  const statuses = { queued: "pending", transcribing: "pending", transcribed: "unclassified", classifying: "pending", complete: "classified", no_audio: "no_audio", no_speech: "no_speech", failed: "error" };
  const posts = raw.posts.map((post) => {
    if (!record(post) || !Object.hasOwn(statuses, post.status)) throw fail("The analysis service returned an unsupported item state.", "INVALID_REELS_JOB", 502);
    if (post.analysis?.schemaVersion != null && post.analysis.schemaVersion !== CREATOR_LAB_VERSION) throw fail("The analysis service returned an unsupported classification.", "INVALID_REELS_JOB", 502);
    const excluded = Boolean(post.excludedReason) || ["no_audio", "no_speech"].includes(post.status);
    return { id: post.id, url: post.url, creator: post.creator, publishedAt: post.publishedAt, scrapedAt: post.scrapedAt,
      caption: post.caption, transcript: post.transcript, duration: post.duration,
      plays: post.plays, views: post.views, likes: post.likes, comments: post.comments,
      status: excluded ? (post.status === "no_audio" ? "no_audio" : "excluded") : statuses[post.status],
      analysis: excluded || post.status === "failed" ? null : post.analysis };
  });
  return { schemaVersion: 1, id: raw.id, creator: raw.creator, createdAt: raw.createdAt, status: raw.status, posts };
}

function boundedSettings(raw) {
  if (!Number.isInteger(raw.limit) || typeof raw.budget !== "number") return null;
  try { return validateAnalysisInput({ creator: raw.creator, limit: raw.limit, budget: raw.budget, language: raw.language ?? "" }); }
  catch { return null; }
}

export function pipelineOrigin(env) {
  const value = env.JEV_SOCIAL_CREATOR_LAB_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw fail("The local analysis service configuration is invalid.", "INVALID_REELS_PIPELINE", 400); }
}

export function validateAnalysisInput(input) {
  if (!record(input) || Object.keys(input).some((key) => !["creator", "limit", "budget", "language"].includes(key))) throw fail("Invalid analysis settings.", "INVALID_REELS_ANALYSIS", 400);
  const creator = typeof input.creator === "string" ? input.creator.trim().replace(/^@/, "").toLowerCase() : "";
  if (!/^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/.test(creator) || creator.includes("..")) throw fail("Enter a valid Instagram handle, such as @example.", "INVALID_REELS_ANALYSIS", 400);
  const { limit = 20, budget = 0.25, language = "" } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("Choose 1 to 100 Reels.", "INVALID_REELS_ANALYSIS", 400);
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0.05 || budget > 30) throw fail("Choose an Apify cap from $0.05 to $30.", "INVALID_REELS_ANALYSIS", 400);
  if (!["", "en", "pt", "es"].includes(language)) throw fail("Choose a supported transcript language.", "INVALID_REELS_ANALYSIS", 400);
  return { creator, limit, budget, language, concurrency: 2 };
}

function summary(raw) {
  if (!record(raw) || typeof raw.id !== "string" || !JOB_ID.test(raw.id) || !/^[\w.]{1,30}$/.test(raw.creator || "")) throw fail("The analysis service returned an invalid job.", "INVALID_REELS_JOB", 502);
  return { id: raw.id, creator: raw.creator, status: STATES.has(raw.status) ? raw.status : "unknown",
    createdAt: typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null,
    total: count(raw.count), classified: count(raw.completed) };
}

function jobView(raw) {
  const base = summary(raw);
  if (raw.schemaVersion !== CREATOR_LAB_VERSION) throw fail("The analysis service returned an unsupported job version.", "INVALID_REELS_JOB", 502);
  if (!Array.isArray(raw.posts) || raw.posts.length > 1000) throw fail("The analysis service returned invalid results.", "INVALID_REELS_JOB", 502);
  let posts = [];
  if (raw.posts.length) {
    try { posts = normalizeReels(adaptCreatorLabJob(raw)).posts; }
    catch { throw fail("The analysis service returned invalid Reel results.", "INVALID_REELS_JOB", 502); }
  }
  const classified = posts.filter((post) => post.status === "classified").length;
  const excluded = posts.filter((post) => post.status === "excluded").length;
  const failed = posts.filter((post) => post.status === "error").length;
  const uncertain = raw.scrapeUncertain === true;
  return { ...base, total: posts.length, classified, excluded, failed, pending: posts.length - classified - excluded - failed,
    limit: count(raw.limit), budget: money(raw.budget), apifyUsd: money(raw.costs?.apify),
    pauseRequested: raw.pauseRequested === true && ACTIVE.has(base.status),
    canPause: ACTIVE.has(base.status) && raw.pauseRequested !== true,
    canResume: RESUMABLE.has(base.status) && !uncertain && Boolean(boundedSettings(raw)),
    message: uncertain ? "Collection launch was not confirmed. Resolve it in Creator Lab before resuming to avoid duplicate charges."
      : !boundedSettings(raw) ? "This saved job is outside the supported analysis limits. Its results remain available, but it cannot be resumed here."
      : raw.error ? "Processing stopped with an error. Completed results are preserved; check the provider connection before resuming."
      : base.status === "complete" && !posts.length ? "The source job completed without usable Reels." : "" };
}

export function createReelsPipeline({ env = process.env, fetchImpl = fetch, save = importReels } = {}) {
  // Keep the configured endpoint fixed for the lifetime of this server; a token
  // obtained from one service must never be forwarded to another origin.
  const endpointEnv = { JEV_SOCIAL_CREATOR_LAB_URL: env.JEV_SOCIAL_CREATOR_LAB_URL };
  let mutating = false;
  async function request(route, { token, body } = {}) {
    const origin = pipelineOrigin(endpointEnv);
    if (!origin) throw fail("Connect the local Creator Lab service to start an analysis.");
    try {
      const response = await fetchImpl(`${origin}${route}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: body === undefined ? {} : { "Content-Type": "application/json", Origin: origin, "X-Lab-Token": token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(response.status === 404 ? "Analysis job not found." : "Creator Lab could not complete the request. Refresh the connection and check the saved job.", "REELS_PIPELINE_REQUEST_FAILED", response.status === 404 ? 404 : 502);
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_REELS_BYTES) throw fail("The analysis response exceeds the supported size.", "REELS_PIPELINE_RESPONSE_TOO_LARGE", 502);
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw fail("The local analysis service did not respond. Check the service, then refresh. Requests are not retried automatically.");
    }
  }
  async function bootstrap() {
    const data = await request("/api/bootstrap");
    if (!record(data) || data.version !== CREATOR_LAB_VERSION || typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token) || !Array.isArray(data.runs) || data.runs.length > 1000 || !["groq", "fireworks"].includes(data.transcriptionProvider)) throw fail("The local analysis service is not compatible.", "REELS_PIPELINE_INCOMPATIBLE", 502);
    return data;
  }
  const readiness = (data) => {
    const required = ["apify", data.transcriptionProvider, "jev"];
    const missing = required.filter((key) => data.connections?.[key]?.configured !== true);
    const jobs = data.runs.map(summary);
    return { available: true, ready: !missing.length, missing, transcriptionProvider: data.transcriptionProvider, jobs,
      busy: jobs.some((job) => ACTIVE.has(job.status) || job.status === "unknown"), message: missing.length ? "Configure the missing providers in Creator Lab before starting." : "Local analysis service connected. Starting or resuming uses paid provider calls." };
  };
  const checkedId = (id) => {
    if (typeof id !== "string" || !JOB_ID.test(id)) throw fail("Invalid analysis job.", "INVALID_REELS_JOB", 400);
    return id;
  };
  async function exclusive(operation) {
    if (mutating) throw fail("Another analysis request is being processed. Refresh its progress first.", "REELS_PIPELINE_BUSY", 409);
    mutating = true;
    try { return await operation(); } finally { mutating = false; }
  }
  async function runKnown(job, token) {
    try {
      const result = await request(`/api/runs/${job.id}/run`, { token, body: { concurrency: 2 } });
      if (result?.id !== job.id) throw fail("The analysis job identity changed.", "INVALID_REELS_JOB", 502);
      return jobView(result);
    }
    catch {
      // A paid start may have succeeded even when its response was lost. Never retry it.
      return { ...jobView(job), status: "unknown", canPause: false, canResume: false,
        message: "Start could not be confirmed. Refresh this job to recover its state; do not create a replacement analysis." };
    }
  }
  return {
    async status() {
      try { return readiness(await bootstrap()); }
      catch (error) { return { available: false, ready: false, busy: false, jobs: [], message: error.message }; }
    },
    start(input) {
      const settings = validateAnalysisInput(input);
      return exclusive(async () => {
        const data = await bootstrap(), state = readiness(data);
        if (!state.ready) throw fail("Configure the required providers in Creator Lab first.", "REELS_PROVIDERS_MISSING", 409);
        if (state.busy) throw fail("Pause the current analysis before starting another.", "REELS_PIPELINE_BUSY", 409);
        const job = await request("/api/runs", { token: data.token, body: settings });
        jobView(job);
        if (job.creator !== settings.creator || job.limit !== settings.limit || job.budget !== settings.budget || (job.language ?? "") !== settings.language || job.status !== "ready") throw fail("The saved analysis settings do not match the requested limits. Check the saved job before starting it.", "INVALID_REELS_JOB", 502);
        return runKnown(job, data.token);
      });
    },
    async read(id) {
      const raw = await request(`/api/runs/${checkedId(id)}`);
      if (raw?.id !== id) throw fail("The analysis job identity changed.", "INVALID_REELS_JOB", 502);
      return jobView(raw);
    },
    change(id, action) {
      checkedId(id);
      if (!["pause", "resume"].includes(action)) throw fail("Unsupported analysis action.", "INVALID_REELS_ACTION", 400);
      return exclusive(async () => {
        const data = await bootstrap(), raw = await request(`/api/runs/${id}`), job = jobView(raw);
        if (raw.id !== id) throw fail("The analysis job identity changed.", "INVALID_REELS_JOB", 502);
        if (action === "pause") {
          if (job.canPause) await request(`/api/runs/${id}/pause`, { token: data.token, body: {} });
          const paused = await request(`/api/runs/${id}`);
          if (paused?.id !== id) throw fail("The analysis job identity changed.", "INVALID_REELS_JOB", 502);
          return jobView(paused);
        }
        if (!job.canResume) throw fail("This analysis cannot be resumed. Refresh its current state first.", "REELS_JOB_NOT_RESUMABLE", 409);
        if (data.runs.some((item) => item.id !== id && (ACTIVE.has(item.status) || !STATES.has(item.status)))) throw fail("Resolve the other active or uncertain analysis first.", "REELS_PIPELINE_BUSY", 409);
        if (!readiness(data).ready) throw fail("Configure the required providers in Creator Lab first.", "REELS_PROVIDERS_MISSING", 409);
        return runKnown(raw, data.token);
      });
    },
    async sync(id) {
      const raw = await request(`/api/runs/${checkedId(id)}`);
      if (raw?.id !== id) throw fail("The analysis job identity changed.", "INVALID_REELS_JOB", 502);
      jobView(raw);
      if (!raw.posts.length) throw fail("No Reels have been collected yet. Refresh the analysis progress first.", "REELS_RESULTS_EMPTY", 409);
      const collection = await save(adaptCreatorLabJob(raw), env);
      return { collectionId: collection.id };
    },
  };
}
