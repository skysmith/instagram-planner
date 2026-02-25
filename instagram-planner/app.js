const STORAGE_KEY = "ig-planner.v1";
const SUGGEST_ENDPOINT = "/api/suggest";
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"];

const state = {
  handles: [],
  files: [],
  remoteImages: {},
  nextcloudLoading: false,
  folderNotice: "",
  images: [],
  selectedImageId: null,
  plans: [],
};

const els = {
  connectLocal: document.querySelector("#connect-local"),
  loadNextcloud: document.querySelector("#load-nextcloud"),
  clearFolders: document.querySelector("#clear-folders"),
  localInput: document.querySelector("#local-input"),
  refreshBtn: document.querySelector("#refresh-btn"),
  folderStatus: document.querySelector("#folder-status"),
  imageCount: document.querySelector("#image-count"),
  gallery: document.querySelector("#gallery"),
  selectedFile: document.querySelector("#selected-file"),
  selectedPreview: document.querySelector("#selected-preview"),
  postForm: document.querySelector("#post-form"),
  caption: document.querySelector("#caption"),
  hashtags: document.querySelector("#hashtags"),
  scheduledAt: document.querySelector("#scheduled-at"),
  aiStatus: document.querySelector("#ai-status"),
  autoRandomBtn: document.querySelector("#auto-random-btn"),
  suggestCaptionBtn: document.querySelector("#suggest-caption-btn"),
  suggestTagsBtn: document.querySelector("#suggest-tags-btn"),
  newPlanBtn: document.querySelector("#new-plan-btn"),
  queue: document.querySelector("#queue"),
  queueTemplate: document.querySelector("#queue-item-template"),
  copyJsonBtn: document.querySelector("#copy-json-btn"),
  exportBtn: document.querySelector("#export-btn"),
  importInput: document.querySelector("#import-input"),
};

init();

function init() {
  loadState();
  wireEvents();
  renderAll();
}

function wireEvents() {
  els.connectLocal.addEventListener("click", connectLocalFolder);
  els.loadNextcloud.addEventListener("click", loadNextcloudSamples);
  els.clearFolders.addEventListener("click", clearFolders);
  els.localInput.addEventListener("change", onLocalFolderSelected);
  els.refreshBtn.addEventListener("click", refreshImages);
  els.postForm.addEventListener("submit", onSavePlan);
  els.autoRandomBtn.addEventListener("click", autoRandomize);
  els.suggestCaptionBtn.addEventListener("click", () => suggestCopy("caption"));
  els.suggestTagsBtn.addEventListener("click", () => suggestCopy("hashtags"));
  els.newPlanBtn.addEventListener("click", clearForm);
  els.copyJsonBtn.addEventListener("click", copyAllPlansJson);
  els.exportBtn.addEventListener("click", exportPlans);
  els.importInput.addEventListener("change", importPlans);
}

async function connectLocalFolder() {
  if (!window.showDirectoryPicker) {
    els.localInput.click();
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    state.handles.push(handle);
    await refreshImages();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.error(err);
    alert("Could not connect folder.");
  }
}

function clearFolders() {
  revokeImageUrls(state.images);
  state.handles = [];
  state.files = [];
  state.remoteImages = {};
  state.folderNotice = "";
  state.images = [];
  state.selectedImageId = null;
  els.localInput.value = "";
  renderAll();
}

async function refreshImages() {
  const nextImages = [];
  revokeImageUrls(state.images);

  for (let index = 0; index < state.handles.length; index += 1) {
    const handle = state.handles[index];
    if (!handle) continue;
    const rootName = handle.name || `folder-${index + 1}`;
    await collectImagesFromHandle(handle, "local", nextImages, rootName);
  }

  if (state.files.length) {
    collectImagesFromFileList(state.files, "local", nextImages);
  }

  for (const images of Object.values(state.remoteImages)) {
    if (!Array.isArray(images)) continue;
    nextImages.push(...images);
  }

  state.images = nextImages.sort((a, b) => a.path.localeCompare(b.path));

  if (!state.images.find((img) => img.id === state.selectedImageId)) {
    state.selectedImageId = state.images[0]?.id ?? null;
  }

  renderAll();
}

async function loadNextcloudSamples() {
  state.nextcloudLoading = true;
  state.folderNotice = "Loading Nextcloud samples...";
  renderFolderStatus();
  els.loadNextcloud.disabled = true;
  els.loadNextcloud.textContent = "Loading...";
  try {
    const response = await fetchWithTimeout("/api/nextcloud/samples", 15000);
    if (!response.ok) {
      let message = `Nextcloud error ${response.status}`;
      try {
        const errJson = await response.json();
        if (errJson?.error) message = `${message}: ${errJson.error}`;
      } catch {
        const errText = await response.text();
        if (errText) message = `${message}: ${errText}`;
      }
      throw new Error(message);
    }
    const payload = await response.json();
    state.remoteImages.nextcloud = (payload.images || []).map((image) => ({
      id: `nextcloud:${image.path}`,
      source: "nextcloud",
      path: image.path,
      name: image.name,
      objectUrl: image.url,
      file: null,
      remote: true,
    }));
    await refreshImages();
    if (state.remoteImages.nextcloud.length) {
      state.folderNotice = `Loaded ${state.remoteImages.nextcloud.length} Nextcloud images.`;
    } else {
      state.folderNotice = "Connected to Nextcloud, but no images were found in that folder.";
      alert(state.folderNotice);
    }
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Could not load Nextcloud samples.";
    state.folderNotice = msg;
    alert(msg);
  } finally {
    state.nextcloudLoading = false;
    els.loadNextcloud.disabled = false;
    els.loadNextcloud.textContent = "Load Nextcloud samples";
    renderFolderStatus();
  }
}

async function onLocalFolderSelected(event) {
  const files = Array.from(event.target.files || []);
  state.files.push(...files);
  await refreshImages();
}

async function collectImagesFromHandle(dirHandle, source, out, parent = "") {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = parent ? `${parent}/${name}` : name;

    if (handle.kind === "directory") {
      await collectImagesFromHandle(handle, source, out, path);
      continue;
    }

    if (!isImageName(name)) continue;

    const file = await handle.getFile();
    const objectUrl = URL.createObjectURL(file);
    out.push({
      id: `${source}:${path}`,
      source,
      path,
      name,
      objectUrl,
      file,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    });
  }
}

function collectImagesFromFileList(files, source, out) {
  for (const file of files) {
    if (!isImageName(file.name)) continue;
    const path = file.webkitRelativePath || file.name;
    out.push({
      id: `${source}:${path}`,
      source,
      path,
      name: file.name,
      objectUrl: URL.createObjectURL(file),
      file,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    });
  }
}

function isImageName(name) {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function revokeImageUrls(images) {
  for (const image of images) {
    if (image?.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(image.objectUrl);
  }
}

function onSavePlan(event) {
  event.preventDefault();

  if (!state.selectedImageId) {
    alert("Select an image first.");
    return;
  }

  const existingIdx = state.plans.findIndex((p) => p.imageId === state.selectedImageId);
  const nextPlan = {
    imageId: state.selectedImageId,
    caption: els.caption.value.trim(),
    hashtags: normalizeHashtags(els.hashtags.value),
    scheduledAt: els.scheduledAt.value || null,
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    state.plans[existingIdx] = nextPlan;
  } else {
    state.plans.push(nextPlan);
  }

  state.plans.sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt) - new Date(b.scheduledAt);
  });

  saveState();
  renderQueue();
}

function normalizeHashtags(raw) {
  return raw
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith("#") ? v : `#${v}`))
    .join(" ");
}

function clearForm() {
  els.caption.value = "";
  els.hashtags.value = "";
  els.scheduledAt.value = "";
}

async function suggestCopy(mode) {
  const selected = state.images.find((img) => img.id === state.selectedImageId);
  if (!selected) {
    setAiStatus("Select an image first.");
    return;
  }

  if (!selected.file) {
    if (!selected.objectUrl) {
      setAiStatus("This image cannot be sent to AI right now.");
      return;
    }
  }

  setAiLoading(true);
  try {
    const payload = await requestSuggestion(mode, selected);
    applySuggestion(mode, payload);
    setAiStatus("Suggestions ready.");
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Suggestion failed.";
    setAiStatus(msg);
    alert(msg);
  } finally {
    setAiLoading(false);
  }
}

async function autoRandomize() {
  if (!state.images.length) {
    setAiStatus("No images loaded yet.");
    return;
  }

  const randomImage = pickRandomImage();
  state.selectedImageId = randomImage.id;
  renderGallery();
  renderSelectedDetails();

  setAiLoading(true);
  setAiStatus("Randomized image and generating caption + hashtags...");
  try {
    const payload = await requestSuggestion("both", randomImage);
    applySuggestion("both", payload);
    setAiStatus("Random post generated. Click again to re-randomize.");
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : "Auto randomize failed.";
    setAiStatus(msg);
    alert(msg);
  } finally {
    setAiLoading(false);
  }
}

function pickRandomImage() {
  if (state.images.length === 1) return state.images[0];
  const currentId = state.selectedImageId;
  const candidates = state.images.filter((img) => img.id !== currentId);
  const pool = candidates.length ? candidates : state.images;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function requestSuggestion(mode, selected) {
  const imageDataUrl = await selectedImageToDataUrl(selected);
  const response = await fetch(SUGGEST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode,
      imageDataUrl,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errText}`);
  }

  return response.json();
}

function applySuggestion(mode, payload) {
  if ((mode === "caption" || mode === "both") && payload.caption) {
    els.caption.value = payload.caption.trim();
  }
  if ((mode === "hashtags" || mode === "both") && payload.hashtags) {
    els.hashtags.value = normalizeHashtags(payload.hashtags);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function selectedImageToDataUrl(selected) {
  if (selected.file) {
    return fileToDataUrl(selected.file);
  }
  const response = await fetch(selected.objectUrl);
  if (!response.ok) throw new Error(`Image fetch failed ${response.status}`);
  const blob = await response.blob();
  return fileToDataUrl(blob);
}

function setAiLoading(isLoading) {
  els.autoRandomBtn.disabled = isLoading;
  els.suggestCaptionBtn.disabled = isLoading;
  els.suggestTagsBtn.disabled = isLoading;
  els.autoRandomBtn.textContent = isLoading ? "Auto..." : "Auto randomize";
  els.suggestCaptionBtn.textContent = isLoading ? "Thinking..." : "Suggest caption";
  els.suggestTagsBtn.textContent = isLoading ? "Thinking..." : "Suggest hashtags";
}

function setAiStatus(message) {
  els.aiStatus.textContent = message;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderAll() {
  renderFolderStatus();
  renderGallery();
  renderSelectedDetails();
  renderQueue();
}

function renderFolderStatus() {
  const labels = [];
  if (state.handles.length) labels.push(`Local folders connected: ${state.handles.length}`);
  if (state.files.length) labels.push("Local folders loaded from disk");
  if (state.remoteImages.nextcloud?.length) labels.push("Nextcloud samples loaded");

  let baseText = "";
  if (!labels.length) {
    baseText = "No folders connected.";
  } else if (window.showDirectoryPicker) {
    baseText = labels.join(" | ");
  } else {
    baseText = `${labels.join(" | ")} | Safari mode: re-pick folders to load new files.`;
  }

  if (state.nextcloudLoading || state.folderNotice) {
    els.folderStatus.textContent = `${baseText} | ${state.folderNotice || "Working..."}`;
  } else {
    els.folderStatus.textContent = baseText;
  }
  els.imageCount.textContent = `${state.images.length} images`;
}

function renderGallery() {
  els.gallery.innerHTML = "";

  for (const image of state.images) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `gallery-item${state.selectedImageId === image.id ? " active" : ""}`;
    btn.title = `${image.source.toUpperCase()}: ${image.path}`;
    btn.addEventListener("click", () => {
      state.selectedImageId = image.id;
      renderGallery();
      renderSelectedDetails();
    });

    const img = document.createElement("img");
    img.src = image.objectUrl;
    img.alt = image.name;
    btn.appendChild(img);
    els.gallery.appendChild(btn);
  }
}

function renderSelectedDetails() {
  const selected = state.images.find((i) => i.id === state.selectedImageId);
  if (!selected) {
    els.selectedFile.textContent = "No image selected";
    els.selectedPreview.removeAttribute("src");
    clearForm();
    return;
  }

  els.selectedFile.textContent = `${selected.source.toUpperCase()} / ${selected.path}`;
  els.selectedPreview.src = selected.objectUrl;
  els.selectedPreview.alt = selected.name;

  const existing = state.plans.find((p) => p.imageId === selected.id);
  els.caption.value = existing?.caption ?? "";
  els.hashtags.value = existing?.hashtags ?? "";
  els.scheduledAt.value = existing?.scheduledAt ?? "";
}

function renderQueue() {
  els.queue.innerHTML = "";

  if (!state.plans.length) {
    const p = document.createElement("p");
    p.className = "status";
    p.textContent = "No posts planned yet.";
    els.queue.appendChild(p);
    return;
  }

  for (const plan of state.plans) {
    const image = state.images.find((i) => i.id === plan.imageId);
    const frag = els.queueTemplate.content.cloneNode(true);

    const imageMeta = frag.querySelector(".queue-image");
    const thumb = frag.querySelector(".queue-thumb");
    const date = frag.querySelector(".queue-date");
    const caption = frag.querySelector(".queue-caption");
    const tags = frag.querySelector(".queue-tags");
    const copyBtn = frag.querySelector(".queue-copy-btn");
    const deleteBtn = frag.querySelector(".danger");

    thumb.src = image?.objectUrl || "";
    thumb.alt = image?.name || "Image unavailable";
    imageMeta.textContent = image
      ? `${image.source.toUpperCase()} / ${image.path}`
      : `Image missing / ${plan.imageId}`;
    date.textContent = plan.scheduledAt
      ? `Scheduled: ${formatDate(plan.scheduledAt)}`
      : "Scheduled: not set";
    caption.textContent = plan.caption || "(No caption)";
    tags.textContent = plan.hashtags || "";

    copyBtn.addEventListener("click", async () => {
      const itemPayload = buildPlanPayload(plan, image);
      const copied = await copyTextToClipboard(JSON.stringify(itemPayload, null, 2));
      setAiStatus(copied ? "Copied plan JSON." : "Could not copy plan JSON.");
    });

    deleteBtn.addEventListener("click", () => {
      state.plans = state.plans.filter((p) => p.imageId !== plan.imageId);
      saveState();
      renderQueue();
    });

    els.queue.appendChild(frag);
  }
}

function formatDate(input) {
  return new Date(input).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state.plans = Array.isArray(parsed.plans) ? parsed.plans : [];
  } catch (err) {
    console.warn("Failed to parse planner state", err);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ plans: state.plans }));
}

function buildPlanPayload(plan, image) {
  return {
    imageId: plan.imageId,
    source: image?.source || null,
    imageName: image?.name || null,
    imagePath: image?.path || null,
    caption: plan.caption || "",
    hashtags: plan.hashtags || "",
    scheduledAt: plan.scheduledAt || null,
    updatedAt: plan.updatedAt || null,
  };
}

async function copyAllPlansJson() {
  const payload = {
    plans: state.plans.map((plan) => {
      const image = state.images.find((i) => i.id === plan.imageId);
      return buildPlanPayload(plan, image);
    }),
  };
  const copied = await copyTextToClipboard(JSON.stringify(payload, null, 2));
  setAiStatus(copied ? "Copied queue JSON." : "Could not copy queue JSON.");
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function exportPlans() {
  const blob = new Blob([JSON.stringify({ plans: state.plans }, null, 2)], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "instagram-post-plans.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importPlans(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.plans)) throw new Error("Invalid format");
    state.plans = data.plans;
    saveState();
    renderQueue();
    renderSelectedDetails();
  } catch (err) {
    console.error(err);
    alert("Invalid JSON file.");
  } finally {
    event.target.value = "";
  }
}
