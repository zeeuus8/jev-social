import { filterReels, knownMetric, LABEL_VALUES, MAX_REELS_BYTES, REELS_SCHEMA_VERSION, REVIEW_THRESHOLD } from "../src/reels-contract.js";

const pageSize = 12;
const labelTitle = (value) => String(value).replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
const metric = (value) => knownMetric(value) ? new Intl.NumberFormat("en").format(value) : "Unknown";
const percent = (value) => knownMetric(value) ? `${Math.floor(value * 100)}%` : "Unknown";
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "Date unknown";
const timestamp = (value) => knownMetric(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}` : "Untimed";
const dimensions = { topic: "Topic", opening: "Opening", mechanism: "Hook", structure: "Structure", evidence: "Evidence", emotion: "Emotion", specificity: "Specificity", cta: "Call to action" };
const statusTitle = (post) => post.needsReview ? "Needs review" : post.status === "error" ? "Processing error" : labelTitle(post.status);
const title = (post) => String(post.transcript?.text || post.caption || post.statusNote || "Untitled Reel").replace(/\s+/g, " ").slice(0, 180);
const safeSource = (url) => typeof url === "string" && /^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]+\/$/.test(url);

export async function readReelsFile(file) {
  if (file.size > MAX_REELS_BYTES) throw new Error("Choose a JSON export no larger than 10 MB.");
  let content;
  try { content = await file.text(); } catch { throw new Error("This file could not be read. Choose it again."); }
  if (new TextEncoder().encode(content).length > MAX_REELS_BYTES) throw new Error("Choose a JSON export no larger than 10 MB.");
  let raw;
  try { raw = JSON.parse(content); } catch { throw new Error("This file is not valid JSON. Choose a Reel collection export."); }
  if (raw?.schemaVersion !== REELS_SCHEMA_VERSION) throw new Error("Choose a version 1 Reel export. Unversioned Creator Lab files need to be converted first.");
  return raw;
}

export async function initReelsLibrary({ document = globalThis.document, window = globalThis.window, fetch = globalThis.fetch } = {}) {
  const $ = (id) => document.getElementById(`reels-${id}`);
  let collection = null, collections = [], matches = [], selected = null, page = 0, revision = 0, importing = false;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function option(select, value, text) { const item = node("option", text); item.value = value; select.append(item); }
  function error(message = "") { $("error").textContent = message; $("error").hidden = !message; }
  function busy(value) { $("content").setAttribute("aria-busy", String(value)); }
  async function api(url, options) {
    let response, body;
    try { response = await fetch(url, options); } catch { throw new Error("Cannot reach the local library. Check that Jev Social is running and try again."); }
    try { body = await response.json(); } catch { throw new Error("The local library returned an unreadable response. Try again."); }
    if (!response.ok) {
      const messages = {
        INVALID_REELS_IMPORT: "This export could not be imported. Check its version, collection and item IDs, classifications, and Instagram source links.",
        BODY_TOO_LARGE: "Choose a JSON export no larger than 10 MB.",
        REELS_SAVE_FAILED: "This collection could not be saved. Your previous saved data is unchanged. Check local storage and try again.",
        REELS_NOT_FOUND: "This collection is unavailable. Choose another collection or import its export again.",
      };
      throw new Error(messages[body?.error?.code] || "The local library could not complete this request. Try again.");
    }
    return body;
  }
  function checkCollection(value) {
    if (value?.schemaVersion !== REELS_SCHEMA_VERSION || !/^reels-[a-f0-9]{24}$/.test(value.id) || !Array.isArray(value.posts) || !value.posts.length) {
      throw new Error("This collection uses an unsupported format. Choose a version 1 Reel export.");
    }
    return value;
  }
  for (const [field, dimension] of [["topic", "topic"], ["hook", "mechanism"], ["structure", "structure"]]) {
    for (const value of LABEL_VALUES[dimension]) option($(field), value, labelTitle(value));
  }
  function renderOverview() {
    $("overview").replaceChildren(...[
      ["REELS IN COLLECTION", collection.posts.length],
      ["CLASSIFIED", collection.posts.filter((post) => post.status === "classified").length],
      ["NEEDS REVIEW", collection.posts.filter((post) => post.needsReview).length],
      ["EXCLUDED / ERRORS", collection.posts.filter((post) => ["excluded", "error"].includes(post.status)).length],
    ].map(([label, count]) => { const item = node("div", undefined, "reels-stat"); item.append(node("span", label), node("strong", String(count))); return item; }));
  }
  function renderCards() {
    const cards = matches.slice(page * pageSize, (page + 1) * pageSize).map((post) => {
      const card = node("button", undefined, "reels-card"); card.type = "button";
      card.setAttribute("aria-pressed", String(post.id === selected));
      card.append(node("span", `@${post.creator} · ${date(post.publishedAt)}`, "reels-author"), node("strong", title(post)),
        node("span", `${metric(post.plays)} plays · ${metric(post.views)} views`, "reels-card-metric"),
        node("span", statusTitle(post), `reels-badge${post.needsReview ? "" : " neutral"}`));
      card.addEventListener("click", () => {
        selected = post.id; renderCards(); renderDetail();
        $("detail").querySelector("h3").focus({ preventScroll: true });
        if (window.matchMedia("(max-width: 720px)").matches) $("detail").scrollIntoView({ block: "start" });
      });
      return card;
    });
    $("cards").replaceChildren(...(cards.length ? cards : [node("p", "No Reels match. Try resetting the filters.", "reels-help")]));
    $("match-count").textContent = `${matches.length} of ${collection.posts.length} Reels`;
    $("page").textContent = matches.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, matches.length)} of ${matches.length}` : "0 Reels";
    $("prev").disabled = page === 0;
    $("next").disabled = (page + 1) * pageSize >= matches.length;
  }
  function segmentList(segments, labeled) {
    const list = node("ol", undefined, "reels-segments");
    for (const segment of segments) {
      const item = node("li", undefined, "reels-segment");
      const time = segment.start === null && segment.end === null ? "Untimed" : `${timestamp(segment.start)}–${timestamp(segment.end)}`;
      item.append(node("small", `${time}${labeled ? ` · ${labelTitle(segment.value)} · ${percent(segment.confidence)} confidence` : ""}`), node("p", segment.text));
      list.append(item);
    }
    return list;
  }
  function renderDetail() {
    const panel = $("detail"), post = matches.find((item) => item.id === selected);
    panel.replaceChildren();
    if (!post) { panel.append(node("p", "Select a Reel to read its saved analysis.", "reels-help")); return; }
    const heading = node("h3", title(post)); heading.tabIndex = -1;
    panel.append(node("p", `@${post.creator} · ${date(post.publishedAt)}`, "eyebrow"), heading);
    if (safeSource(post.url)) {
      const link = node("a", "Open original Reel ↗"); link.href = post.url; link.target = "_blank"; link.rel = "noopener noreferrer"; panel.append(link);
    }
    panel.append(node("p", `${metric(post.plays)} plays · ${metric(post.views)} views\n${metric(post.likes)} likes · ${metric(post.comments)} comments\n${statusTitle(post)}`, "reels-detail-meta"));
    if (post.needsReview) panel.append(node("p", "Review suggested: a label or script segment is unclear, below 65% confidence, or missing confidence. Read the transcript before using these classifications.", "reels-review-note"));
    if (post.statusNote) panel.append(node("p", post.statusNote, "reels-review-note"));
    if (post.analysis) {
      const labels = node("dl", undefined, "reels-labels");
      for (const [key, name] of Object.entries(dimensions)) {
        const label = post.analysis.labels[key], uncertain = label.confidence < REVIEW_THRESHOLD || label.value === "unclear";
        const row = node("div", undefined, `reels-label-row${uncertain ? " uncertain" : ""}`);
        row.append(node("dt", name), node("dd", labelTitle(label.value)), node("dd", `${percent(label.confidence)}${uncertain ? " · review" : ""}`, "reels-confidence"));
        labels.append(row);
      }
      panel.append(labels);
    }
    panel.append(node("h4", "TRANSCRIPT"), node("p", post.transcript.text || "No transcript is available for this Reel.", "reels-transcript"));
    if (post.transcript.segments.length) {
      const details = node("details"); details.append(node("summary", "Timestamped transcript"), segmentList(post.transcript.segments, false)); panel.append(details);
    }
    if (post.analysis?.anatomy.length) {
      const details = node("details"); details.append(node("summary", "Script roles & confidence"), segmentList(post.analysis.anatomy, true)); panel.append(details);
    }
    if (post.caption) {
      const details = node("details"); details.append(node("summary", "Original caption"), node("p", post.caption, "reels-transcript")); panel.append(details);
    }
  }
  function render(resetPage = true) {
    if (!collection) return;
    matches = filterReels(collection.posts, { topic: $("topic").value, mechanism: $("hook").value, structure: $("structure").value, review: $("review").value, minConfidence: Number($("confidence").value) });
    if (resetPage) page = 0;
    const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
    if (!visible.some((post) => post.id === selected)) selected = visible[0]?.id || null;
    renderCards(); renderDetail();
  }
  function options() {
    $("collection").replaceChildren();
    for (const item of collections) option($("collection"), item.id, `@${item.creator} · ${item.itemCount} Reels · ${item.sourceId}`);
    if (!collections.length) option($("collection"), "", "No saved collections");
    $("collection").disabled = importing || collections.length === 0;
    if (collection) $("collection").value = collection.id;
  }
  function show(loaded) {
    collection = loaded; selected = null;
    $("content").hidden = false; $("empty").hidden = true; $("retry").hidden = true;
    $("collection").value = loaded.id;
    $("message").textContent = `@${loaded.creator} · Source snapshot: ${labelTitle(loaded.sourceStatus)} · Created ${date(loaded.createdAt)}.${loaded.duplicateCount ? ` ${loaded.duplicateCount} identical duplicate items removed.` : ""} This is a saved snapshot; importing does not resume processing.`;
    const location = new URL(window.location.href); location.searchParams.set("collection", loaded.id);
    window.history.replaceState(null, "", location);
    $("filters").reset(); renderOverview(); render();
  }
  async function loadCollection(id) {
    const ticket = ++revision;
    $("content").hidden = true; $("empty").hidden = true; $("retry").hidden = true;
    $("message").textContent = "Loading collection…"; error(); busy(true);
    try {
      const loaded = checkCollection(await api(`/api/reels/${encodeURIComponent(id)}`));
      if (ticket === revision) show(loaded);
    } catch (failure) {
      if (ticket !== revision) return;
      $("content").hidden = !collection;
      if (collection) $("collection").value = collection.id;
      $("message").textContent = collection ? "The selected collection could not be opened. Showing your last loaded collection." : "Collection unavailable. Choose another collection or import an export.";
      $("retry").hidden = false; error(failure.message);
    } finally { if (ticket === revision) busy(false); }
  }
  async function loadLibrary(preferred) {
    const ticket = ++revision;
    error(); busy(true); $("retry").hidden = true; $("message").textContent = "Loading saved collections…";
    try {
      const body = await api("/api/reels");
      if (ticket !== revision) return;
      if (!Array.isArray(body?.collections)) throw new Error("The local library returned an unreadable collection list. Try again.");
      collections = body.collections; options();
      if (!collections.length) {
        collection = null; $("content").hidden = true; $("empty").hidden = false;
        $("message").textContent = "Ready to import your first collection.";
        const location = new URL(window.location.href); location.searchParams.delete("collection"); window.history.replaceState(null, "", location);
        return;
      }
      const id = collections.some((item) => item.id === preferred) ? preferred : collections[0].id;
      await loadCollection(id);
    } catch (failure) {
      if (ticket !== revision) return;
      $("retry").hidden = false; $("message").textContent = "Saved collections could not be loaded."; error(failure.message);
    } finally { if (ticket === revision) busy(false); }
  }
  $("filters").addEventListener("submit", (event) => event.preventDefault());
  $("filters").addEventListener("change", () => render());
  $("reset").addEventListener("click", () => { $("filters").reset(); render(); });
  for (const [id, direction] of [["prev", -1], ["next", 1]]) $(id).addEventListener("click", () => {
    if ($(id).disabled) return;
    page += direction; render(false);
  });
  $("collection").addEventListener("change", () => loadCollection($("collection").value));
  $("retry").addEventListener("click", () => loadLibrary(collection?.id));
  for (const id of ["import-button", "empty-import"]) $(id).addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async () => {
    const file = $("file").files[0];
    if (!file || importing) return;
    importing = true; ++revision; busy(true); error();
    for (const id of ["import-button", "empty-import", "collection", "retry"]) $(id).disabled = true;
    $("import-button").textContent = "Importing…";
    $("message").textContent = "Importing collection…";
    try {
      const raw = await readReelsFile(file);
      const imported = checkCollection(await api("/api/reels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(raw) }));
      collections = collections.filter((item) => item.id !== imported.id);
      collections.push({ id: imported.id, sourceId: imported.sourceId, creator: imported.creator, itemCount: imported.posts.length });
      options(); show(imported);
    } catch (failure) {
      if (collection) $("collection").value = collection.id;
      $("message").textContent = `Import was not confirmed.${collection ? " Showing your last loaded collection." : ""} Retry loading to check saved collections before importing again.`;
      $("content").hidden = !collection; $("retry").hidden = false; error(failure.message);
    } finally {
      importing = false; busy(false); $("file").value = "";
      for (const id of ["import-button", "empty-import", "retry"]) $(id).disabled = false;
      $("collection").disabled = collections.length === 0; $("import-button").textContent = "Import collection ↑";
    }
  });
  await loadLibrary(new URL(window.location.href).searchParams.get("collection"));
}
