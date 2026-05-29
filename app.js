const API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const WIKI_ROOT = "https://en.wikipedia.org";
const DEFAULT_ARTICLE = "Wikipedia";
const INITIAL_HISTORY_LIMIT = 120;
const HISTORY_BACKFILL_LIMIT = 250;
const HISTORY_BACKFILL_TRIGGER_MARGIN = 10;
const PREFETCH_RADIUS = 10;

const state = {
  title: DEFAULT_ARTICLE,
  revisions: [],
  revisionCache: new Map(),
  diffStatsByRevision: new Map(),
  inaccessibleRevisionIds: new Set(),
  diffTargets: [],
  activeDiffTargetIndex: -1,
  selectedRevisionId: null,
  requestedRevisionId: null,
  loadGeneration: 0,
  renderGeneration: 0,
  prefetchGeneration: 0,
  historyBackfillGeneration: 0,
  loadingHistory: false,
  loadingMoreHistory: false,
  loadedAllHistory: false,
  historyCount: 0,
  continueToken: null,
};

const articleForm = document.getElementById("article-form");
const articleInput = document.getElementById("article-input");
const articleFrame = document.getElementById("article-frame");
const timelineSlider = document.getElementById("timeline-slider");
const timelineStrip = document.getElementById("timeline-strip");
const timelineSummary = document.getElementById("timeline-summary");
const lengthChart = document.getElementById("length-chart");
const attributionNote = document.getElementById("attribution-note");
const olderButton = document.getElementById("older-button");
const newerButton = document.getElementById("newer-button");

function setArticlePlaceholder(className, text) {
  articleFrame.innerHTML = `<div class="${className}">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeTitle(rawTitle) {
  return rawTitle.trim().replaceAll("_", " ");
}

function buildUrl(title, revisionId = null) {
  const url = new URL(window.location.href);
  url.searchParams.set("article", title);
  if (revisionId) {
    url.searchParams.set("rev", revisionId);
  } else {
    url.searchParams.delete("rev");
  }
  return url;
}

function syncUrl(title, revisionId = null) {
  window.history.replaceState({}, "", buildUrl(title, revisionId));
}

function stripHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = value || "";
  return normalizeTitle(template.content.textContent || "");
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function clampMarkerCount(value) {
  return Math.max(0, Math.min(3, value || 0));
}

function isDeletedRevisionError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("deleted text") ||
    message.includes("deleted revision") ||
    message.includes("permission to view deleted") ||
    message.includes("permission to view deleted text") ||
    message.includes("permissiondenied")
  );
}

function getRevisionIndexById(revisionId) {
  return state.revisions.findIndex((entry) => entry.revid === revisionId);
}

function getSelectedRevision() {
  const index = getRevisionIndexById(state.selectedRevisionId);
  return index >= 0 ? state.revisions[index] : null;
}

function getPreviousRevision(revisionId) {
  const index = getRevisionIndexById(revisionId);
  if (index <= 0) {
    return null;
  }
  return state.revisions[index - 1];
}

function removeRevisionById(revisionId) {
  const index = getRevisionIndexById(revisionId);
  if (index < 0) {
    return -1;
  }
  state.inaccessibleRevisionIds.add(revisionId);
  state.revisions.splice(index, 1);
  state.historyCount = state.revisions.length;
  state.revisionCache.delete(revisionId);
  state.diffStatsByRevision.delete(revisionId);
  if (state.requestedRevisionId === revisionId) {
    state.requestedRevisionId = null;
  }
  return index;
}

function upsertRevision(revision) {
  if (!revision || !revision.revid) {
    return;
  }
  const existingIndex = getRevisionIndexById(revision.revid);
  if (existingIndex >= 0) {
    state.revisions[existingIndex] = revision;
  } else {
    state.revisions.push(revision);
  }
  state.revisions.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  state.historyCount = state.revisions.length;
}

async function skipInaccessibleSelectedRevision(revisionId) {
  const removedIndex = removeRevisionById(revisionId);
  if (!state.revisions.length) {
    state.selectedRevisionId = null;
    renderTimeline();
    setArticlePlaceholder("error-state", "Wikipedia returned only inaccessible revisions for this selection.");
    return;
  }
  const fallbackIndex = Math.max(0, Math.min(removedIndex, state.revisions.length - 1));
  state.selectedRevisionId = state.revisions[fallbackIndex].revid;
  renderTimeline();
  await renderSelectedRevision();
}

async function fetchJson(params) {
  const query = new URLSearchParams({
    format: "json",
    formatversion: "2",
    origin: "*",
    ...params,
  });
  const response = await fetch(`${API_ENDPOINT}?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Wikipedia API request failed: ${response.status}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.info || "Wikipedia API returned an error.");
  }
  return data;
}

async function fetchRevisionBatch(title, continueToken = null, limit = INITIAL_HISTORY_LIMIT) {
  const params = {
    action: "query",
    prop: "revisions",
    redirects: "1",
    titles: title,
    rvprop: "ids|timestamp|user|comment|size|flags",
    rvlimit: String(limit),
    rvdir: "older",
  };
  if (continueToken) {
    params.rvcontinue = continueToken;
  }
  const data = await fetchJson(params);
  const page = data.query?.pages?.[0];
  if (!page || page.missing) {
    throw new Error(`Could not find a Wikipedia article named "${title}".`);
  }
  return {
    canonicalTitle: page.title,
    revisions: page.revisions || [],
    continueToken: data.continue?.rvcontinue || null,
  };
}

async function fetchRevisionMetadataById(revisionId) {
  const data = await fetchJson({
    action: "query",
    prop: "revisions",
    revids: String(revisionId),
    rvprop: "ids|timestamp|user|comment|size|flags",
  });
  const page = data.query?.pages?.find((entry) => Array.isArray(entry.revisions) && entry.revisions.length);
  if (!page || page.missing) {
    throw new Error(`Could not load revision ${revisionId}.`);
  }
  return {
    canonicalTitle: page.title,
    revision: page.revisions[0] || null,
  };
}

async function fetchPreviousRevisionMetadata(title, revisionId) {
  const data = await fetchJson({
    action: "query",
    prop: "revisions",
    redirects: "1",
    titles: title,
    rvprop: "ids|timestamp|user|comment|size|flags",
    rvlimit: "2",
    rvstartid: String(revisionId),
    rvdir: "older",
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing) {
    return null;
  }
  const revisions = page.revisions || [];
  if (!revisions.length) {
    return null;
  }
  if (revisions.length >= 2 && revisions[0].revid === revisionId) {
    return revisions[1];
  }
  return revisions[0].revid === revisionId ? null : revisions[0];
}

async function fetchRevisionHtml(revisionId) {
  if (state.revisionCache.has(revisionId)) {
    return state.revisionCache.get(revisionId);
  }
  const data = await fetchJson({
    action: "parse",
    oldid: revisionId,
    prop: "text|displaytitle",
    disableeditsection: "1",
    disablelimitreport: "1",
    disabletoc: "0",
  });
  const html = data.parse?.text || "";
  const payload = {
    html,
    displayTitle: data.parse?.displaytitle || state.title,
  };
  state.revisionCache.set(revisionId, payload);
  return payload;
}

function ensureSelection() {
  if (!state.revisions.length) {
    state.selectedRevisionId = null;
    return;
  }

  if (state.requestedRevisionId) {
    const requestedIndex = getRevisionIndexById(state.requestedRevisionId);
    if (requestedIndex >= 0) {
      state.selectedRevisionId = state.requestedRevisionId;
      state.requestedRevisionId = null;
      return;
    }
  }

  if (getRevisionIndexById(state.selectedRevisionId) >= 0) {
    return;
  }
  state.selectedRevisionId = state.revisions[state.revisions.length - 1].revid;
}

function renderTimelineSummary() {
  const revision = getSelectedRevision();
  const previousRevision = revision ? getPreviousRevision(revision.revid) : null;
  const stats = state.diffStatsByRevision.get(state.selectedRevisionId);
  if (!revision) {
    timelineSummary.textContent = "";
    return;
  }

  const sizeLabel = `${formatCount(revision.size || 0)} chars`;
  const deltaValue = previousRevision ? (revision.size || 0) - (previousRevision.size || 0) : 0;
  const deltaLabel = previousRevision
    ? `${deltaValue >= 0 ? "+" : ""}${formatCount(deltaValue)}`
    : "n/a";
  const statsMarkup = stats
    ? `
    <span class="timeline-stat"><span class="timeline-stat-swatch is-added"></span>+${stats.added}</span>
    <span class="timeline-stat"><span class="timeline-stat-swatch is-removed"></span>-${stats.removed}</span>
  `
    : "";

  timelineSummary.innerHTML = `
    <span class="timeline-meta-text">Date: ${escapeHtml(formatDate(revision.timestamp))}</span>
    <span class="timeline-meta-text">Author: ${escapeHtml(revision.user || "Unknown")}</span>
    <span class="timeline-meta-text">Length: ${sizeLabel}</span>
    <span class="timeline-meta-text">Edit: ${deltaLabel}</span>
    ${statsMarkup}
  `;
}

function renderLengthChart() {
  const revisionsWithSize = state.revisions.filter((revision) => typeof revision.size === "number");
  if (revisionsWithSize.length < 2) {
    lengthChart.innerHTML = `<div class="length-chart-empty">Article length chart will appear as more revision sizes load.</div>`;
    return;
  }

  const width = 1000;
  const height = 92;
  const left = 8;
  const right = 8;
  const top = 8;
  const bottom = 18;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const sizes = revisionsWithSize.map((revision) => revision.size || 0);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  const span = Math.max(1, maxSize - minSize);

  const pointAt = (index) => {
    const revision = revisionsWithSize[index];
    const x = left + (plotWidth * index) / Math.max(1, revisionsWithSize.length - 1);
    const y = top + plotHeight - (((revision.size || 0) - minSize) / span) * plotHeight;
    return [x, y];
  };

  const path = revisionsWithSize
    .map((revision, index) => {
      const [x, y] = pointAt(index);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const selectedIndex = revisionsWithSize.findIndex((revision) => revision.revid === state.selectedRevisionId);
  const selectedPoint = selectedIndex >= 0 ? pointAt(selectedIndex) : null;
  const selectedSize = selectedIndex >= 0 ? revisionsWithSize[selectedIndex].size || 0 : null;

  lengthChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Article length over loaded revisions">
      <line class="length-chart-axis" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"></line>
      <path class="length-chart-line" d="${path}"></path>
      ${selectedPoint ? `<circle class="length-chart-point" cx="${selectedPoint[0]}" cy="${selectedPoint[1]}" r="3"></circle>` : ""}
      <text class="length-chart-text" x="${left}" y="${top + 8}">max ${escapeHtml(formatCount(maxSize))}</text>
      <text class="length-chart-text" x="${left}" y="${height - 4}">min ${escapeHtml(formatCount(minSize))}</text>
      ${selectedPoint ? `<text class="length-chart-text" x="${Math.min(width - 80, selectedPoint[0] + 6)}" y="${Math.max(12, selectedPoint[1] - 6)}">${escapeHtml(formatCount(selectedSize))}</text>` : ""}
    </svg>
  `;
}

function renderAttributionNote() {
  const revision = getSelectedRevision();
  const articleUrl = `${WIKI_ROOT}/wiki/${encodeURIComponent(state.title.replaceAll(" ", "_"))}`;
  const historyUrl = `${WIKI_ROOT}/w/index.php?title=${encodeURIComponent(state.title)}&action=history`;
  const revisionUrl = revision
    ? `${WIKI_ROOT}/w/index.php?title=${encodeURIComponent(state.title)}&oldid=${revision.revid}`
    : articleUrl;

  attributionNote.innerHTML = `
    Unofficial viewer. Content from Wikipedia may be reused under the applicable free licenses; see
    <a href="${articleUrl}" target="_blank" rel="noreferrer">article</a>,
    <a href="${revisionUrl}" target="_blank" rel="noreferrer">selected revision</a>, and
    <a href="${historyUrl}" target="_blank" rel="noreferrer">page history</a>
    for source and authors.
  `;
}

function resetDiffTargets() {
  state.diffTargets = [];
  state.activeDiffTargetIndex = -1;
}

function collectDiffTargets() {
  const articleRoot = articleFrame.querySelector(".wiki-root");
  if (!articleRoot) {
    resetDiffTargets();
    return;
  }

  const targets = [];
  const seen = new Set();
  const pushTarget = (node) => {
    if (!node || seen.has(node)) {
      return;
    }
    seen.add(node);
    targets.push(node);
  };

  articleRoot.querySelectorAll(".diff-added, .diff-removed-block").forEach((node) => {
    pushTarget(node);
  });

  articleRoot.querySelectorAll(".diff-inline-added, .diff-inline-removed").forEach((node) => {
    pushTarget(node.closest("p, li, dd, dt, td, th, figcaption, blockquote"));
  });

  state.diffTargets = targets;
  state.activeDiffTargetIndex = targets.length ? 0 : -1;
}

function setActiveDiffTarget(index, shouldScroll = true) {
  if (!state.diffTargets.length) {
    state.activeDiffTargetIndex = -1;
    return;
  }

  const normalizedIndex = Math.max(0, Math.min(index, state.diffTargets.length - 1));
  state.diffTargets.forEach((node) => node.classList.remove("is-active-diff-target"));
  const target = state.diffTargets[normalizedIndex];
  if (!target) {
    state.activeDiffTargetIndex = -1;
    return;
  }

  target.classList.add("is-active-diff-target");
  state.activeDiffTargetIndex = normalizedIndex;
  if (shouldScroll) {
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }
}

function moveToDiffTarget(step) {
  if (!state.diffTargets.length) {
    return;
  }
  const nextIndex = state.activeDiffTargetIndex < 0
    ? 0
    : Math.max(0, Math.min(state.activeDiffTargetIndex + step, state.diffTargets.length - 1));
  setActiveDiffTarget(nextIndex, true);
}

async function loadOlderHistoryBatch() {
  if (state.loadingHistory || state.loadingMoreHistory || state.loadedAllHistory || !state.continueToken) {
    return false;
  }

  const generation = state.loadGeneration;
  state.loadingMoreHistory = true;
  try {
    const result = await fetchRevisionBatch(state.title, state.continueToken, HISTORY_BACKFILL_LIMIT);
    if (generation !== state.loadGeneration) {
      return false;
    }
    mergeRevisions(result.revisions);
    state.continueToken = result.continueToken;
    state.loadedAllHistory = !result.continueToken;
    renderTimeline();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  } finally {
    if (generation === state.loadGeneration) {
      state.loadingMoreHistory = false;
    }
  }
}

function maybeLoadMoreHistoryForSelection() {
  const selectedIndex = getRevisionIndexById(state.selectedRevisionId);
  if (selectedIndex < 0) {
    return;
  }
  if (selectedIndex <= HISTORY_BACKFILL_TRIGGER_MARGIN) {
    void loadOlderHistoryBatch();
  }
}

function startBackgroundHistoryBackfill() {
  state.historyBackfillGeneration += 1;
  const generationToken = state.historyBackfillGeneration;

  const tick = async () => {
    if (generationToken !== state.historyBackfillGeneration || state.loadGeneration === 0) {
      return;
    }
    if (state.loadedAllHistory || !state.continueToken) {
      return;
    }
    await loadOlderHistoryBatch();
    if (generationToken !== state.historyBackfillGeneration || state.loadedAllHistory || !state.continueToken) {
      return;
    }
    window.setTimeout(tick, 250);
  };

  window.setTimeout(tick, 250);
}

async function prefetchRevisionAndContext(revision, generationToken) {
  if (!revision || generationToken !== state.prefetchGeneration) {
    return;
  }

  try {
    await fetchRevisionHtml(revision.revid);
  } catch (error) {
    if (!isDeletedRevisionError(error)) {
      console.error(error);
    }
    return;
  }

  if (generationToken !== state.prefetchGeneration) {
    return;
  }

  let previousRevision = getPreviousRevision(revision.revid);
  if (!previousRevision) {
    try {
      previousRevision = await fetchPreviousRevisionMetadata(state.title, revision.revid);
      if (previousRevision) {
        upsertRevision(previousRevision);
      }
    } catch (error) {
      if (!isDeletedRevisionError(error)) {
        console.error(error);
      }
      return;
    }
  }

  if (!previousRevision || generationToken !== state.prefetchGeneration) {
    return;
  }

  try {
    await fetchRevisionHtml(previousRevision.revid);
  } catch (error) {
    if (!isDeletedRevisionError(error)) {
      console.error(error);
    }
  }
}

function prefetchAroundSelectedRevision() {
  const selectedIndex = getRevisionIndexById(state.selectedRevisionId);
  if (selectedIndex < 0) {
    return;
  }

  state.prefetchGeneration += 1;
  const generationToken = state.prefetchGeneration;
  const offsets = [0];
  for (let distance = 1; distance <= PREFETCH_RADIUS; distance += 1) {
    offsets.push(-distance, distance);
  }
  const candidates = offsets
    .map((offset) => state.revisions[selectedIndex + offset])
    .filter(Boolean);

  window.setTimeout(async () => {
    for (const revision of candidates) {
      if (generationToken !== state.prefetchGeneration) {
        return;
      }
      await prefetchRevisionAndContext(revision, generationToken);
    }
  }, 0);
}

function maybeMilestone(index) {
  if (index === 0 || index === state.revisions.length - 1) {
    return true;
  }
  if (state.revisions.length <= 15) {
    return true;
  }
  const step = Math.max(1, Math.floor(state.revisions.length / 12));
  return index % step === 0;
}

function renderTimeline() {
  if (!state.revisions.length) {
    timelineSlider.disabled = true;
    timelineSlider.min = "0";
    timelineSlider.max = "0";
    timelineSlider.value = "0";
    olderButton.disabled = true;
    newerButton.disabled = true;
    timelineStrip.innerHTML = "";
    timelineSummary.textContent = "";
    lengthChart.innerHTML = "";
    attributionNote.textContent = "";
    return;
  }

  ensureSelection();
  const selectedIndex = getRevisionIndexById(state.selectedRevisionId);
  const selectedRevision = state.revisions[selectedIndex];
  timelineSlider.disabled = false;
  timelineSlider.min = "0";
  timelineSlider.max = String(state.revisions.length - 1);
  timelineSlider.value = String(selectedIndex);
  olderButton.disabled = selectedIndex <= 0;
  newerButton.disabled = selectedIndex >= state.revisions.length - 1;

  timelineStrip.innerHTML = "";
  const fragment = document.createDocumentFragment();

  const maxTicks = 180;
  const stride = Math.max(1, Math.ceil(state.revisions.length / maxTicks));

  state.revisions.forEach((revision, index) => {
    if (index % stride !== 0 && revision.revid !== state.selectedRevisionId && index !== state.revisions.length - 1) {
      return;
    }
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = `timeline-tick${maybeMilestone(index) ? " is-milestone" : ""}${revision.revid === state.selectedRevisionId ? " is-selected" : ""}`;
    tick.dataset.revisionId = revision.revid;
    const diffStats = state.diffStatsByRevision.get(revision.revid);
    const diffText = diffStats
      ? ` | +${diffStats.added} -${diffStats.removed}`
      : "";
    tick.dataset.label = `${formatDate(revision.timestamp)} | ${revision.user || "Unknown"}${diffText}`;
    tick.title = `${formatDate(revision.timestamp)} - ${revision.user || "Unknown"}${revision.comment ? ` - ${revision.comment}` : ""}${diffText}`;
    tick.setAttribute("aria-label", `Revision from ${formatDate(revision.timestamp)}`);
    if (diffStats) {
      const markers = document.createElement("span");
      markers.className = "tick-markers";
      [
        ["is-added", clampMarkerCount(diffStats.added)],
        ["is-removed", clampMarkerCount(diffStats.removed)],
      ].forEach(([className, count]) => {
        for (let markerIndex = 0; markerIndex < count; markerIndex += 1) {
          const marker = document.createElement("span");
          marker.className = `tick-marker ${className}`;
          markers.appendChild(marker);
        }
      });
      tick.appendChild(markers);
    }
    fragment.appendChild(tick);
  });

  timelineStrip.appendChild(fragment);
  const selectedTick = timelineStrip.querySelector(".timeline-tick.is-selected");
  selectedTick?.scrollIntoView({ block: "nearest", inline: "center" });
  renderTimelineSummary();
  renderLengthChart();
  renderAttributionNote();
  syncUrl(state.title, selectedRevision?.revid || null);
  maybeLoadMoreHistoryForSelection();
}

function parseHtmlFragment(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeNode(node) {
  return {
    tag: node.tagName.toLowerCase(),
    text: normalizeText(node.textContent || ""),
    rawText: (node.textContent || "").trim(),
  };
}

function buildSignature(summary) {
  return `${summary.tag}:${summary.text}`;
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tokenizeForDiff(value) {
  return String(value).match(/\s+|[^\s]+/g) || [];
}

function buildTokenPairs(previousTokens, currentTokens) {
  const rows = previousTokens.length + 1;
  const cols = currentTokens.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = previousTokens.length - 1; i >= 0; i -= 1) {
    for (let j = currentTokens.length - 1; j >= 0; j -= 1) {
      if (previousTokens[i] === currentTokens[j]) {
        matrix[i][j] = matrix[i + 1][j + 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < previousTokens.length && j < currentTokens.length) {
    if (previousTokens[i] === currentTokens[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function renderInlineWordDiff(previousText, currentText) {
  const previousTokens = tokenizeForDiff(previousText);
  const currentTokens = tokenizeForDiff(currentText);
  const pairs = buildTokenPairs(previousTokens, currentTokens);
  const html = [];
  let prevCursor = 0;
  let currCursor = 0;

  const flushRun = (nextPrevIndex, nextCurrIndex) => {
    if (prevCursor < nextPrevIndex) {
      html.push(`<span class="diff-inline-removed">${escapeHtmlText(previousTokens.slice(prevCursor, nextPrevIndex).join(""))}</span>`);
    }
    if (currCursor < nextCurrIndex) {
      html.push(`<span class="diff-inline-added">${escapeHtmlText(currentTokens.slice(currCursor, nextCurrIndex).join(""))}</span>`);
    }
  };

  for (const [prevIndex, currIndex] of [...pairs, [previousTokens.length, currentTokens.length]]) {
    flushRun(prevIndex, currIndex);
    prevCursor = prevIndex;
    currCursor = currIndex;
    if (prevIndex < previousTokens.length && currIndex < currentTokens.length) {
      html.push(escapeHtmlText(currentTokens[currIndex]));
      prevCursor += 1;
      currCursor += 1;
    }
  }

  return html.join("");
}

function canInlineDiff(node, previousSummary, currentSummary) {
  if (!previousSummary.rawText || !currentSummary.rawText) {
    return false;
  }
  if (previousSummary.tag !== currentSummary.tag) {
    return false;
  }
  return /^(p|li|dd|dt|td|th|figcaption|blockquote)$/.test(node.tagName.toLowerCase());
}

function insertRemovedBlock(currentContainer, summary, anchorNode = null) {
  if (!summary.rawText) {
    return false;
  }
  const wrapper = document.createElement("div");
  wrapper.className = "diff-removed-block";
  const paragraph = document.createElement("p");
  paragraph.textContent = summary.rawText;
  wrapper.appendChild(paragraph);
  currentContainer.insertBefore(wrapper, anchorNode);
  return true;
}

function buildLcsPairs(previousBlocks, currentBlocks) {
  const rows = previousBlocks.length + 1;
  const cols = currentBlocks.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = previousBlocks.length - 1; i >= 0; i -= 1) {
    for (let j = currentBlocks.length - 1; j >= 0; j -= 1) {
      if (buildSignature(previousBlocks[i]) === buildSignature(currentBlocks[j])) {
        matrix[i][j] = matrix[i + 1][j + 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
  }

  const pairs = [];
  let i = 0;
  let j = 0;

  while (i < previousBlocks.length && j < currentBlocks.length) {
    if (buildSignature(previousBlocks[i]) === buildSignature(currentBlocks[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function annotateDiff(previousRoot, currentRoot) {
  const currentContainer = currentRoot.querySelector(".mw-parser-output") || currentRoot;
  const previousContainer = previousRoot?.querySelector(".mw-parser-output") || previousRoot;
  const currentChildren = [...currentContainer.children];
  const previousChildren = previousContainer ? [...previousContainer.children] : [];

  const currentBlocks = currentChildren.map(summarizeNode);
  const previousBlocks = previousChildren.map(summarizeNode);

  if (!previousBlocks.length) {
    return {
      added: 0,
      removed: 0,
    };
  }

  const pairs = buildLcsPairs(previousBlocks, currentBlocks);
  const stats = { added: 0, removed: 0 };
  let prevCursor = 0;
  let currCursor = 0;

  const insertRemovedNote = (summary, anchorNode = null) => {
    if (insertRemovedBlock(currentContainer, summary, anchorNode)) {
      stats.removed += 1;
    }
  };

  const flushRun = (nextExactCurrentIndex) => {
    const prevRun = previousBlocks.slice(prevCursor, nextExactCurrentIndex.prev);
    const currRun = currentBlocks.slice(currCursor, nextExactCurrentIndex.curr);
    const pairCount = Math.min(prevRun.length, currRun.length);

    for (let index = 0; index < pairCount; index += 1) {
      const node = currentChildren[currCursor + index];
      const previousSummary = prevRun[index];
      const currentSummary = currRun[index];
      if (!currentSummary.text) {
        continue;
      }
      if (canInlineDiff(node, previousSummary, currentSummary)) {
        node.innerHTML = renderInlineWordDiff(previousSummary.rawText, currentSummary.rawText);
        if (previousSummary.rawText !== currentSummary.rawText) {
          stats.added += 1;
          stats.removed += 1;
        }
      } else {
        node.classList.add("diff-added");
        stats.added += 1;
        insertRemovedNote(previousSummary, node);
      }
    }

    for (let index = pairCount; index < currRun.length; index += 1) {
      const node = currentChildren[currCursor + index];
      if (!currRun[index].text) {
        continue;
      }
      node.classList.add("diff-added");
      stats.added += 1;
    }

    const anchorNode = currentChildren[nextExactCurrentIndex.curr] || null;
    for (let index = pairCount; index < prevRun.length; index += 1) {
      insertRemovedNote(prevRun[index], anchorNode);
    }
  };

  for (const [prevIndex, currIndex] of [...pairs, [previousBlocks.length, currentBlocks.length]]) {
    flushRun({ prev: prevIndex, curr: currIndex });
    prevCursor = prevIndex;
    currCursor = currIndex;

    if (prevIndex < previousBlocks.length && currIndex < currentBlocks.length) {
      prevCursor += 1;
      currCursor += 1;
    }
  }

  return stats;
}

function rewriteWikiLinks(root) {
  root.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href) {
      return;
    }

    if (href.startsWith("./")) {
      const [pagePart, hashPart] = href.slice(2).split("#");
      const decoded = decodeURIComponent(pagePart.replaceAll("_", " "));
      anchor.dataset.articleTitle = decoded;
      anchor.href = buildUrl(decoded).toString() + (hashPart ? `#${hashPart}` : "");
      return;
    }

    if (href.startsWith("/wiki/")) {
      const [pagePart, hashPart] = href.slice("/wiki/".length).split("#");
      const decoded = decodeURIComponent(pagePart.replaceAll("_", " "));
      anchor.dataset.articleTitle = decoded;
      anchor.href = buildUrl(decoded).toString() + (hashPart ? `#${hashPart}` : "");
      return;
    }

    if (href.startsWith("//")) {
      anchor.href = `https:${href}`;
      return;
    }

    if (href.startsWith("/")) {
      anchor.href = `${WIKI_ROOT}${href}`;
    }
  });

  root.querySelectorAll("[src]").forEach((node) => {
    const src = node.getAttribute("src");
    if (!src) {
      return;
    }
    if (src.startsWith("//")) {
      node.src = `https:${src}`;
    } else if (src.startsWith("/")) {
      node.src = `${WIKI_ROOT}${src}`;
    }
  });
}

function mountArticle(contentRoot) {
  const canvas = document.createElement("div");
  canvas.className = "article-canvas wiki-root";
  canvas.appendChild(contentRoot);
  articleFrame.innerHTML = "";
  articleFrame.appendChild(canvas);
  collectDiffTargets();
}

async function renderSelectedRevision() {
  const revision = getSelectedRevision();
  const renderGeneration = ++state.renderGeneration;

  if (!revision) {
    setArticlePlaceholder("empty-state", "No revision selected.");
    resetDiffTargets();
    renderTimelineSummary();
    return;
  }

  setArticlePlaceholder("loading-state", "Fetching article body for the selected revision...");

  try {
    let currentPayload;
    try {
      currentPayload = await fetchRevisionHtml(revision.revid);
    } catch (error) {
      if (isDeletedRevisionError(error)) {
        if (renderGeneration !== state.renderGeneration) {
          return;
        }
        await skipInaccessibleSelectedRevision(revision.revid);
        return;
      }
      throw error;
    }

    let previousRevision = revision ? getPreviousRevision(revision.revid) : null;
    if (!previousRevision && revision) {
      try {
        previousRevision = await fetchPreviousRevisionMetadata(state.title, revision.revid);
        if (previousRevision) {
          upsertRevision(previousRevision);
        }
      } catch (previousMetadataError) {
        console.error(previousMetadataError);
      }
    }

    let previousPayload = null;
    if (previousRevision) {
      try {
        previousPayload = await fetchRevisionHtml(previousRevision.revid);
      } catch (error) {
        if (isDeletedRevisionError(error)) {
          removeRevisionById(previousRevision.revid);
          previousPayload = null;
        } else {
          throw error;
        }
      }
    }

    if (renderGeneration !== state.renderGeneration || revision.revid !== state.selectedRevisionId) {
      return;
    }

    const normalizedDisplayTitle = stripHtml(currentPayload.displayTitle || state.title);
    document.title = normalizedDisplayTitle || state.title;

    const currentRoot = parseHtmlFragment(currentPayload.html);
    const currentWrapper = document.createElement("div");
    currentWrapper.appendChild(currentRoot);

    const previousWrapper = document.createElement("div");
    if (previousPayload?.html) {
      previousWrapper.appendChild(parseHtmlFragment(previousPayload.html));
    }

    rewriteWikiLinks(currentWrapper);
    let stats;
    try {
      stats = annotateDiff(previousWrapper, currentWrapper);
    } catch (diffError) {
      console.error(diffError);
      stats = { added: 0, removed: 0 };
    }
    if (renderGeneration !== state.renderGeneration || revision.revid !== state.selectedRevisionId) {
      return;
    }
    state.diffStatsByRevision.set(revision.revid, stats);
    mountArticle(currentWrapper);
    setActiveDiffTarget(0, true);
    renderTimeline();
    prefetchAroundSelectedRevision();
  } catch (error) {
    if (renderGeneration !== state.renderGeneration) {
      return;
    }
    console.error(error);
    resetDiffTargets();
    setArticlePlaceholder("error-state", error.message || "Unable to render this revision.");
  }
}

function mergeRevisions(batch) {
  const seen = new Set(state.revisions.map((revision) => revision.revid));
  const unique = batch.filter((revision) => !seen.has(revision.revid));
  if (!unique.length) {
    return;
  }

  const chronologicalBatch = unique.slice().reverse();
  state.revisions = chronologicalBatch.concat(state.revisions);
  state.historyCount = state.revisions.length;
}

async function loadArticleHistory(title) {
  state.loadGeneration += 1;
  const generation = state.loadGeneration;
  state.title = title;
  state.revisions = [];
  state.revisionCache = new Map();
  state.diffStatsByRevision = new Map();
  state.inaccessibleRevisionIds = new Set();
  resetDiffTargets();
  state.selectedRevisionId = null;
  state.loadingHistory = true;
  state.loadingMoreHistory = false;
  state.loadedAllHistory = false;
  state.historyCount = 0;
  state.renderGeneration = 0;
  state.prefetchGeneration = 0;
  state.historyBackfillGeneration = 0;
  state.continueToken = null;
  articleInput.value = title;
  setArticlePlaceholder("loading-state", "Loading recent revisions from Wikipedia...");
  renderTimeline();

  try {
    const result = await fetchRevisionBatch(title, null, INITIAL_HISTORY_LIMIT);
    if (generation !== state.loadGeneration) {
      return;
    }

    state.title = result.canonicalTitle;
    articleInput.value = result.canonicalTitle;
    mergeRevisions(result.revisions);
    state.continueToken = result.continueToken;
    if (state.requestedRevisionId && getRevisionIndexById(state.requestedRevisionId) < 0) {
      try {
        const requested = await fetchRevisionMetadataById(state.requestedRevisionId);
        if (generation !== state.loadGeneration) {
          return;
        }
        state.title = requested.canonicalTitle;
        articleInput.value = requested.canonicalTitle;
        upsertRevision(requested.revision);
      } catch (requestedError) {
        console.error(requestedError);
      }
    }
    state.loadedAllHistory = !result.continueToken;
    state.loadingHistory = false;
    ensureSelection();
    renderTimeline();
    startBackgroundHistoryBackfill();
    await renderSelectedRevision();
  } catch (error) {
    console.error(error);
    state.loadingHistory = false;
    state.loadedAllHistory = false;
    setArticlePlaceholder("error-state", error.message || "Unable to load this article.");
  }
}

function selectRevisionByIndex(index) {
  if (!state.revisions.length) {
    return;
  }
  const clamped = Math.max(0, Math.min(index, state.revisions.length - 1));
  const revision = state.revisions[clamped];
  if (!revision || revision.revid === state.selectedRevisionId) {
    renderTimeline();
    return;
  }
  state.selectedRevisionId = revision.revid;
  renderTimeline();
  renderSelectedRevision();
}

function handleArticleNavigation(targetTitle) {
  const normalized = normalizeTitle(targetTitle);
  if (!normalized) {
    return;
  }
  state.requestedRevisionId = null;
  loadArticleHistory(normalized);
}

articleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  handleArticleNavigation(articleInput.value || DEFAULT_ARTICLE);
});

document.querySelectorAll(".article-chip").forEach((button) => {
  button.addEventListener("click", () => {
    handleArticleNavigation(button.dataset.article || DEFAULT_ARTICLE);
  });
});

timelineSlider.addEventListener("input", (event) => {
  selectRevisionByIndex(Number(event.target.value));
});

olderButton.addEventListener("click", () => {
  const currentIndex = getRevisionIndexById(state.selectedRevisionId);
  selectRevisionByIndex(currentIndex - 1);
});

newerButton.addEventListener("click", () => {
  const currentIndex = getRevisionIndexById(state.selectedRevisionId);
  selectRevisionByIndex(currentIndex + 1);
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTypingTarget =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable;

  if (isTypingTarget) {
    return;
  }

  if (event.key === "ArrowLeft" && !olderButton.disabled) {
    event.preventDefault();
    olderButton.click();
  } else if (event.key === "ArrowRight" && !newerButton.disabled) {
    event.preventDefault();
    newerButton.click();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveToDiffTarget(-1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    moveToDiffTarget(1);
  }
});

timelineStrip.addEventListener("click", (event) => {
  const button = event.target.closest(".timeline-tick");
  if (!button) {
    return;
  }
  const revisionId = Number(button.dataset.revisionId);
  const index = getRevisionIndexById(revisionId);
  selectRevisionByIndex(index);
});

articleFrame.addEventListener("click", (event) => {
  const anchor = event.target.closest("a[data-article-title]");
  if (!anchor) {
    return;
  }
  event.preventDefault();
  handleArticleNavigation(anchor.dataset.articleTitle);
});

function boot() {
  const url = new URL(window.location.href);
  const queryArticle = normalizeTitle(url.searchParams.get("article") || DEFAULT_ARTICLE);
  const queryRevision = Number(url.searchParams.get("rev")) || null;
  state.requestedRevisionId = queryRevision;
  articleInput.value = queryArticle;
  loadArticleHistory(queryArticle);
}

boot();
