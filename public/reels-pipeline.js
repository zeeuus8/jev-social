const ACTIVE = new Set(["running", "scraping", "unknown"]);
const TITLES = { ready: "Ready to start", scraping: "Collecting Reels", running: "Analyzing speech", paused: "Paused", interrupted: "Interrupted", partial: "Finished with some failures", failed: "Analysis stopped", complete: "Analysis complete", unknown: "Recovering analysis state" };

export function initReelsPipeline(onImported, { document = globalThis.document, window = globalThis.window, fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  const $ = (id) => document.getElementById(`analysis-${id}`);
  let job = null, selected = "", timer, busy = false, service = null, generation = 0, autoOpen = "", uncertainRequest = false;
  const error = (message = "") => { $("error").textContent = message; $("error").hidden = !message; };
  async function api(path, body) {
    let response, payload;
    try { response = await fetch(`/api/reels/${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch { throw new Error("The analysis request could not be confirmed. Refresh the connection before starting or resuming again."); }
    try { payload = await response.json(); } catch { throw new Error("The analysis service returned an unreadable response. Refresh the connection to recover the saved job."); }
    if (!response.ok) {
      const failure = new Error(payload.error?.message || "The analysis request could not be completed.");
      failure.retrySafe = ["INVALID_REELS_ANALYSIS", "REELS_PROVIDERS_MISSING", "REELS_PIPELINE_BUSY", "REELS_JOB_NOT_RESUMABLE"].includes(payload.error?.code);
      throw failure;
    }
    return payload;
  }
  function controls() {
    $("start").disabled = busy || uncertainRequest || !service?.ready || service.busy || Boolean(job && ACTIVE.has(job.status));
    $("creator").disabled = busy;
    $("job").disabled = busy;
    $("refresh").disabled = busy;
    $("pause").disabled = busy;
    $("resume").disabled = busy || uncertainRequest || !service?.ready;
    $("open").disabled = busy || !job?.total;
  }
  function render() {
    if (!job) return;
    if (service?.jobs) {
      service.jobs = service.jobs.map((item) => item.id === job.id ? { ...item, status: job.status } : item);
      service.busy = service.jobs.some((item) => ACTIVE.has(item.status));
    }
    $("jobs").hidden = false;
    $("stage").textContent = `@${job.creator} · ${job.pauseRequested ? "Pausing after in-flight requests" : TITLES[job.status] || "Unknown state"}`;
    $("progress").max = Math.max(job.total, job.limit || 0, 1);
    $("progress").value = job.classified + job.excluded + job.failed;
    $("counts").textContent = `${job.total} collected · ${job.classified} classified · ${job.excluded} excluded · ${job.failed} failed · ${job.pending} pending`;
    const cost = job.apifyUsd === null ? "Apify spend not reported yet." : `Reported Apify spend: $${job.apifyUsd.toFixed(4)}.`;
    $("note").textContent = [job.message, cost, "Other provider charges are separate."].filter(Boolean).join(" ");
    $("pause").hidden = !job.canPause;
    $("resume").hidden = !job.canResume;
    $("resume").textContent = job.status === "ready" ? "Start saved analysis →" : "Resume analysis →";
    controls();
  }
  async function saveResults() {
    const result = await api(`jobs/${encodeURIComponent(selected)}/sync`, {});
    await onImported(result.collectionId);
  }
  async function readJob() {
    clearTimeout(timer);
    if (!selected) return;
    const id = selected, ticket = ++generation;
    try {
      const result = await api(`jobs/${encodeURIComponent(id)}`);
      if (ticket !== generation || id !== selected) return;
      job = result;
      render();
      if (job.status === "paused") autoOpen = "";
      if (ACTIVE.has(job.status)) timer = setTimeout(readJob, 2500);
      else if (autoOpen === id && job.total) { autoOpen = ""; await saveResults(); }
      return true;
    } catch (failure) {
      if (ticket === generation) error(`${failure.message} Use Refresh connection to recover the saved job.`);
    }
  }
  function select(id) {
    selected = id;
    $("job").value = id;
    const location = new URL(window.location.href);
    location.searchParams.set("job", id);
    window.history.replaceState(null, "", location);
    return readJob();
  }
  async function refresh(preferred = selected) {
    clearTimeout(timer);
    const status = await api("pipeline");
    service = status;
    $("connection").textContent = status.message + (status.missing?.length ? ` Missing: ${status.missing.map((name) => name === "jev" ? "Jev" : name[0].toUpperCase() + name.slice(1)).join(", ")}.` : "");
    controls();
    if (!status.available) return;
    const jobs = status.jobs || [];
    $("job").replaceChildren(...jobs.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `@${item.creator} · ${item.total} Reels · ${TITLES[item.status] || "Unknown state"}${item.createdAt ? ` · ${new Date(item.createdAt).toLocaleDateString("en")}` : ""}`;
      return option;
    }));
    $("jobs").hidden = !jobs.length;
    if (jobs.length) {
      const recovered = await select(jobs.some((item) => item.id === preferred) ? preferred : (jobs.find((item) => ACTIVE.has(item.status)) || jobs[0]).id);
      if (recovered && job && job.status !== "unknown") uncertainRequest = false;
      controls();
    }
    else { job = null; selected = ""; controls(); }
  }
  async function action(operation) {
    if (busy) return;
    busy = true; ++generation; clearTimeout(timer); error(); controls();
    try { await operation(); }
    catch (failure) { if (failure.retrySafe) uncertainRequest = false; error(failure.message); }
    finally { busy = false; controls(); if (job && ACTIVE.has(job.status)) { clearTimeout(timer); timer = setTimeout(readJob, 2500); } }
  }
  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("start").disabled) return;
    return action(async () => {
      uncertainRequest = true;
      const result = await api("jobs", { creator: $("creator").value, limit: Number($("limit").value), budget: Number($("budget").value), language: $("language").value });
      uncertainRequest = false;
      job = result; selected = result.id; autoOpen = result.id;
      render();
      await refresh(result.id);
    });
  });
  $("refresh").addEventListener("click", () => action(() => refresh()));
  $("job").addEventListener("change", () => action(() => select($("job").value)));
  $("open").addEventListener("click", () => action(saveResults));
  for (const name of ["pause", "resume"]) $(name).addEventListener("click", () => {
    if ($(name).disabled || $(name).hidden) return;
    return action(async () => {
      if (name === "resume") { autoOpen = selected; uncertainRequest = true; }
      job = await api(`jobs/${encodeURIComponent(selected)}/${name}`, {});
      uncertainRequest = false;
      render(); await readJob();
    });
  });
  void refresh(new URL(window.location.href).searchParams.get("job") || "").catch((failure) => {
    $("connection").textContent = "The local analysis service could not be checked. The saved library is still available.";
    error(failure.message);
  });
  return { refresh };
}
