"use strict";

const MAX_PAGES = 20;
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const MIN_CROP_EDGE = 50;
const ACTIVE_JOB_KEY = "textbook-reader-active-job";
const RECOVERY_DB = "textbook-reader-recovery";

const photoInput = document.querySelector("#photo-input");
const cameraButton = document.querySelector("#camera-button");
const cameraInput = document.querySelector("#camera-input");
const textInput = document.querySelector("#text-input");
const addTextButton = document.querySelector("#add-text-button");
const pageCount = document.querySelector("#page-count");
const previewEmpty = document.querySelector("#preview-empty");
const pageList = document.querySelector("#page-list");
const pageTemplate = document.querySelector("#page-template");
const recordingNameInput = document.querySelector("#recording-name");
const convertButton = document.querySelector("#convert-button");
const retryButton = document.querySelector("#retry-button");
const clearButton = document.querySelector("#clear-button");
const status = document.querySelector("#status");
const conversionProgress = document.querySelector("#conversion-progress");
const progressBar = document.querySelector("#progress-bar");
const progressDetails = document.querySelector("#progress-details");
const audioResult = document.querySelector("#audio-result");
const audioPlayer = document.querySelector("#audio-player");
const audioDownload = document.querySelector("#audio-download");
const cropDialog = document.querySelector("#crop-dialog");
const cropPreview = document.querySelector("#crop-preview");
const cropControls = document.querySelector("#crop-controls");
const cropInputs = Array.from(cropControls.querySelectorAll("[data-crop-edge]"));
const cropError = document.querySelector("#crop-error");
const cropHeading = document.querySelector("#crop-heading");
const cropReset = document.querySelector("#crop-reset");
const cropCancel = document.querySelector("#crop-cancel");
const cropApply = document.querySelector("#crop-apply");

const pages = [];
let stage = "waiting";
let message = "Add a photo or paste text to begin.";
let preparing = false;
let audioUrl = null;
let requestController = null;
let operation = 0;
let nextPageId = 1;
let cropPage = null;
let cropBitmap = null;
let cropReturnPageId = null;
let activeJobId = sessionStorage.getItem(ACTIVE_JOB_KEY);
let latestJob = null;

const extractionLabels = {
  ready: "ready to convert",
  extracting: "extracting text",
  readable: "text extracted",
  partial: "needs a clearer photo",
  unreadable: "no readable text found",
  failed: "processing interrupted",
};

function render() {
  const busy = preparing || requestController !== null;
  status.dataset.state = stage;
  status.setAttribute(
    "aria-busy",
    stage === "extracting" || stage === "synthesizing" ? "true" : "false",
  );
  status.textContent = message;
  renderProgress();

  if (stage === "complete" && audioUrl) {
    audioDownload.href = audioUrl;
    audioDownload.hidden = false;
  } else {
    audioDownload.removeAttribute("href");
    audioDownload.hidden = true;
  }

  pageCount.textContent = `${pages.length} ${pages.length === 1 ? "page" : "pages"} selected`;
  previewEmpty.hidden = pages.length > 0;
  pageList.hidden = pages.length === 0;
  pageList.replaceChildren(...pages.map((page, index) => {
    const position = index + 1;
    const card = pageTemplate.content.firstElementChild.cloneNode(true);
    const preview = card.querySelector("[data-page-preview]");
    const textPreview = card.querySelector("[data-page-text-preview]");

    card.dataset.pageId = page.id;
    if (page.kind === "text") {
      preview.hidden = true;
      textPreview.hidden = false;
      textPreview.textContent = page.text;
    } else {
      preview.src = page.previewUrl;
      preview.alt = `Preview of page ${position}: ${page.name}`;
    }
    card.querySelector("[data-page-position]").textContent = position;
    card.querySelector("[data-page-file-name]").textContent = page.name;
    const extractionState = card.querySelector("[data-page-extraction-state]");
    extractionState.dataset.state = page.extractionState;
    extractionState.textContent = page.kind === "text"
      ? "pasted text ready"
      : extractionLabels[page.extractionState];

    const actions = card.querySelector(".page-actions");
    actions.setAttribute("aria-label", `Actions for page ${position}: ${page.name}`);
    for (const button of actions.querySelectorAll("button")) {
      const labels = {
        "move-up": `Move page ${position} up`,
        "move-down": `Move page ${position} down`,
        replace: `Replace page ${position}`,
        crop: `Crop page ${position}`,
        duplicate: `Duplicate page ${position}`,
        remove: `Remove page ${position}`,
        retry: `Retry text extraction for page ${position}`,
      };
      button.setAttribute("aria-label", labels[button.dataset.action]);
      button.disabled = busy
        || (button.dataset.action === "move-up" && index === 0)
        || (button.dataset.action === "move-down" && index === pages.length - 1);
      if (page.kind === "text" && ["replace", "crop", "retry"].includes(button.dataset.action)) {
        button.hidden = true;
      } else if (button.dataset.action === "retry") {
        button.hidden = !["partial", "unreadable", "failed"].includes(page.extractionState);
      }
    }
    return card;
  }));

  convertButton.disabled = !pages.length || busy || stage !== "waiting";
  recordingNameInput.disabled = busy || stage === "complete";
  retryButton.hidden = !pages.length || (stage !== "attention" && stage !== "failed");
  retryButton.disabled = busy;
  clearButton.disabled = !pages.length;
}

function setStage(nextStage, nextMessage) {
  stage = nextStage;
  message = nextMessage;
  render();
}

function formatDuration(seconds) {
  seconds = Math.max(1, Math.ceil(seconds));
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

function renderProgress() {
  const active = ["extracting", "synthesizing"].includes(stage);
  conversionProgress.hidden = !active;
  if (!active) return;
  if (!latestJob || /reconnecting/i.test(message)) {
    progressBar.removeAttribute("value");
    progressDetails.textContent = "Waiting for conversion status — estimating time remaining…";
    return;
  }
  progressBar.value = latestJob.progress_percent || 0;
  const elapsed = Math.max(0, (Date.now() / 1000) - latestJob.created_at);
  const sinceUpdate = Math.max(0, Date.now() / 1000 - latestJob.progress_updated_at);
  const remaining = latestJob.remaining_seconds;
  const estimate = remaining == null
    ? "Estimating time remaining…"
    : sinceUpdate >= remaining
      ? "Taking longer than estimated; conversion is still active."
      : `About ${formatDuration(remaining - sinceUpdate)} remaining (estimate)`;
  progressDetails.textContent = `${progressBar.value}% complete · ${formatDuration(elapsed)} elapsed · ${estimate}`;
}

function clearAudio() {
  audioDownload.removeAttribute("href");
  audioDownload.hidden = true;
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
  audioResult.hidden = true;
  if (audioUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(audioUrl);
  }
  audioUrl = null;
}

function recoveryStore(mode) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECOVERY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("jobs");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("jobs", mode);
      resolve({ database, transaction, store: transaction.objectStore("jobs") });
    };
  });
}

async function saveRecovery(jobId) {
  const { database, transaction, store } = await recoveryStore("readwrite");
  store.put({
    createdAt: Date.now(),
    name: recordingNameInput.value,
    pages: pages.map((page) => ({
      id: page.id,
      kind: page.kind,
      name: page.name,
      source: page.source || null,
      image: page.image || null,
      crop: page.crop || null,
      extractionState: page.extractionState,
      text: page.text,
      confidence: page.confidence,
      issues: page.issues,
    })),
  }, jobId);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function restoreRecovery(jobId) {
  const { database, store } = await recoveryStore("readonly");
  const request = store.get(jobId);
  const saved = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  if (!saved || pages.length) return;

  recordingNameInput.value = saved.name || "";
  for (const savedPage of saved.pages) {
    if (savedPage.kind === "text") {
      pages.push({ ...savedPage, error: null });
    } else {
      pages.push({
        ...savedPage,
        source: savedPage.source || savedPage.image,
        previewUrl: URL.createObjectURL(savedPage.image),
        error: null,
      });
    }
    const number = Number(savedPage.id.replace("page-", ""));
    if (Number.isInteger(number)) nextPageId = Math.max(nextPageId, number + 1);
  }
}

async function deleteRecovery(jobId) {
  const { database, transaction, store } = await recoveryStore("readwrite");
  store.delete(jobId);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function cleanupRecovery() {
  const { database, store } = await recoveryStore("readwrite");
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const request = store.openCursor();
  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (!cursor.value.createdAt || cursor.value.createdAt < cutoff) cursor.delete();
      cursor.continue();
    };
  });
  database.close();
}

function forgetActiveJob() {
  latestJob = null;
  const jobId = activeJobId;
  activeJobId = null;
  sessionStorage.removeItem(ACTIVE_JOB_KEY);
  if (jobId) deleteRecovery(jobId).catch(() => {});
}

function stopCurrentOperation() {
  forgetActiveJob();
  operation += 1;
  requestController?.abort();
  requestController = null;
  preparing = false;
  for (const page of pages) {
    if (page.extractionState === "extracting") page.extractionState = "ready";
  }
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("JPEG encoding failed.")),
      "image/jpeg",
      0.9,
    );
  });
}

async function normalizeImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      "This photo could not be opened. Choose a supported image or retake it as a JPEG.",
    );
  }

  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("This browser could not prepare the photo. Try another browser.");
    }
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToJpeg(canvas);
    if (blob.type !== "image/jpeg") {
      throw new Error("This browser could not encode the photo as JPEG. Try another browser.");
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new Error(
        "The prepared photo is over 4 MiB. Crop it more tightly or choose a lower-resolution photo.",
      );
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

function newPage(file, source, image = source, crop = { top: 0, right: 0, bottom: 0, left: 0 }) {
  return {
    id: `page-${nextPageId++}`,
    kind: "image",
    name: file.name || "camera photo",
    source,
    image,
    crop: { ...crop },
    previewUrl: URL.createObjectURL(image),
    extractionState: "ready",
    text: "",
    confidence: 0,
    issues: [],
    error: null,
  };
}

function newTextPage(text) {
  return {
    id: `page-${nextPageId++}`,
    kind: "text",
    name: "Pasted text",
    extractionState: "readable",
    text,
    confidence: 1,
    issues: [],
    error: null,
  };
}

function duplicatePage(page) {
  const index = pages.indexOf(page);
  if (index < 0) return;
  if (pages.length >= MAX_PAGES) {
    message = `You can keep up to ${MAX_PAGES} pages. Remove a page before duplicating another.`;
    render();
    return;
  }
  stopCurrentOperation();
  const duplicate = page.kind === "text"
    ? newTextPage(page.text)
    : newPage({ name: page.name }, page.source, page.image, page.crop);
  pages.splice(index + 1, 0, duplicate);
  clearAudio();
  setStage(
    "waiting",
    `Page ${index + 1} was duplicated as page ${index + 2}. ${
      page.kind === "text" ? "Review the order" : "Crop each copy"
    }, then confirm and convert.`,
  );
  if (page.kind === "image") focusCropButton(duplicate.id);
}

function cropSelection() {
  const crop = Object.fromEntries(cropInputs.map((input) => [input.dataset.cropEdge, Number(input.value)]));
  const left = Math.round(cropBitmap.width * crop.left / 100);
  const top = Math.round(cropBitmap.height * crop.top / 100);
  const right = Math.round(cropBitmap.width * (1 - crop.right / 100));
  const bottom = Math.round(cropBitmap.height * (1 - crop.bottom / 100));
  return { crop, left, top, width: right - left, height: bottom - top };
}

function renderCrop() {
  if (!cropBitmap) return false;
  for (const input of cropInputs) {
    document.querySelector(`#${input.id}-value`).value = `${input.value}%`;
  }
  const selection = cropSelection();
  const valid = selection.width >= MIN_CROP_EDGE && selection.height >= MIN_CROP_EDGE;
  cropError.textContent = valid ? "" : `Leave at least ${MIN_CROP_EDGE} pixels of width and height.`;
  cropApply.disabled = !valid || preparing;
  if (!valid) {
    cropPreview.width = 1;
    cropPreview.height = 1;
    return null;
  }

  cropPreview.width = selection.width;
  cropPreview.height = selection.height;
  cropPreview.getContext("2d").drawImage(
    cropBitmap,
    selection.left,
    selection.top,
    selection.width,
    selection.height,
    0,
    0,
    selection.width,
    selection.height,
  );
  return selection;
}

function focusCropButton(pageId) {
  requestAnimationFrame(() => {
    pageList.querySelector(`[data-page-id="${pageId}"] [data-action="crop"]`)?.focus();
  });
}

function closeCrop(restoreFocus = false) {
  const pageId = cropReturnPageId;
  cropBitmap?.close();
  cropBitmap = null;
  cropPage = null;
  cropReturnPageId = null;
  cropPreview.width = 1;
  cropPreview.height = 1;
  cropControls.disabled = false;
  cropReset.disabled = false;
  cropCancel.disabled = false;
  cropApply.disabled = false;
  if (restoreFocus && pageId) focusCropButton(pageId);
}

async function openCrop(page) {
  const currentOperation = ++operation;
  const previousStage = stage;
  const pageId = page.id;
  preparing = true;
  render();
  try {
    const bitmap = await createImageBitmap(page.source);
    if (currentOperation !== operation || !pages.includes(page)) {
      bitmap.close();
      return;
    }
    cropBitmap = bitmap;
    cropPage = page;
    cropReturnPageId = page.id;
    cropHeading.textContent = `Crop page ${pages.indexOf(page) + 1}`;
    for (const input of cropInputs) input.value = page.crop[input.dataset.cropEdge];
    cropError.textContent = "";
    renderCrop();
    cropDialog.showModal();
  } catch {
    if (currentOperation !== operation) return;
    closeCrop();
    setStage(
      previousStage,
      `Page ${pages.indexOf(page) + 1} could not be opened for cropping. The page was not changed.`,
    );
    focusCropButton(pageId);
  } finally {
    if (currentOperation === operation) {
      preparing = false;
      render();
      renderCrop();
    }
  }
}

async function applyCrop() {
  if (!cropPage) return;
  const selection = renderCrop();
  if (!selection) return;
  const page = cropPage;
  const currentOperation = ++operation;
  preparing = true;
  cropControls.disabled = true;
  cropReset.disabled = true;
  cropCancel.disabled = true;
  cropApply.disabled = true;
  cropError.textContent = "Preparing cropped page...";
  render();
  try {
    const image = await canvasToJpeg(cropPreview);
    if (currentOperation !== operation || !pages.includes(page)) {
      if (cropDialog.open) cropDialog.close();
      return;
    }
    if (image.size > MAX_IMAGE_BYTES) throw new Error("The cropped photo is over 4 MiB. Trim it more tightly.");
    const previewUrl = URL.createObjectURL(image);
    const oldPreviewUrl = page.previewUrl;
    page.image = image;
    page.crop = selection.crop;
    page.previewUrl = previewUrl;
    page.extractionState = "ready";
    page.text = "";
    page.confidence = 0;
    page.issues = [];
    page.error = null;
    URL.revokeObjectURL(oldPreviewUrl);
    clearAudio();
    cropDialog.close();
    setStage("waiting", `Page ${pages.indexOf(page) + 1} was cropped. Review the preview, then confirm and convert.`);
  } catch (error) {
    if (currentOperation !== operation) {
      if (cropDialog.open) cropDialog.close();
      return;
    }
    cropError.textContent = error instanceof Error ? error.message : "The crop could not be applied.";
  } finally {
    if (currentOperation === operation) {
      preparing = false;
      cropControls.disabled = false;
      cropReset.disabled = false;
      cropCancel.disabled = false;
      render();
      renderCrop();
    }
  }
}

async function addImages(event) {
  const input = event.currentTarget;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length) return;

  const closedCrop = cropDialog.open;
  if (closedCrop) {
    cropDialog.close();
    stopCurrentOperation();
  }

  if (pages.length + files.length > MAX_PAGES) {
    message = `You can keep up to ${MAX_PAGES} pages. Remove ${
      pages.length + files.length - MAX_PAGES
    } page${pages.length + files.length - MAX_PAGES === 1 ? "" : "s"}, or choose fewer photos.`;
    render();
    return;
  }

  if (!closedCrop) stopCurrentOperation();
  const currentOperation = operation;
  preparing = true;
  const additions = [];
  const failures = [];

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStage("waiting", `Preparing photo ${index + 1} of ${files.length}...`);
      if (file.size > MAX_ORIGINAL_BYTES) {
        failures.push(`${file.name || "A photo"}: the original is over 20 MiB. Choose a smaller photo.`);
        continue;
      }
      try {
        additions.push({ file, image: await normalizeImage(file) });
      } catch (error) {
        failures.push(`${file.name || "A photo"}: ${
          error instanceof Error ? error.message : "The photo could not be prepared. Choose another photo."
        }`);
      }
      if (currentOperation !== operation) return;
    }

    if (currentOperation !== operation) return;
    if (additions.length) {
      pages.push(...additions.map(({ file, image }) => newPage(file, image)));
      clearAudio();
    }

    const added = `${additions.length} ${additions.length === 1 ? "page" : "pages"} added.`;
    const failed = failures.length
      ? ` ${failures.length} ${failures.length === 1 ? "photo was" : "photos were"} not added. ${failures[0]}`
      : "";
    if (additions.length) {
      setStage(
        "waiting",
        `${added} ${pages.length} ${pages.length === 1 ? "page is" : "pages are"} ready to review.${failed}`,
      );
    } else {
      setStage(audioUrl ? "complete" : "failed", `${failures[0]} Your existing pages were kept.`);
    }
  } finally {
    if (currentOperation === operation) {
      preparing = false;
      render();
    }
  }
}

function addText() {
  const text = textInput.value.trim();
  if (!text) {
    message = "Paste some text before adding a page.";
    render();
    textInput.focus();
    return;
  }
  if (pages.length >= MAX_PAGES) {
    message = `You can keep up to ${MAX_PAGES} pages. Remove a page before adding another.`;
    render();
    return;
  }

  stopCurrentOperation();
  pages.push(newTextPage(text));
  textInput.value = "";
  clearAudio();
  setStage("waiting", `Pasted text was added as page ${pages.length}. Add another page or confirm and convert.`);
}

async function replaceImage(page, file) {
  stopCurrentOperation();
  const currentOperation = operation;
  preparing = true;
  setStage("waiting", `Preparing a replacement for page ${pages.indexOf(page) + 1}...`);

  try {
    if (file.size > MAX_ORIGINAL_BYTES) {
      throw new Error("That original photo is over 20 MiB. Choose a smaller photo.");
    }
    const image = await normalizeImage(file);
    if (currentOperation !== operation || !pages.includes(page)) return;

    const previewUrl = URL.createObjectURL(image);
    const oldPreviewUrl = page.previewUrl;
    page.name = file.name || "camera photo";
    page.source = image;
    page.image = image;
    page.crop = { top: 0, right: 0, bottom: 0, left: 0 };
    page.previewUrl = previewUrl;
    page.extractionState = "ready";
    page.text = "";
    page.confidence = 0;
    page.issues = [];
    page.error = null;
    URL.revokeObjectURL(oldPreviewUrl);
    clearAudio();
    setStage(
      "waiting",
      `Page ${pages.indexOf(page) + 1} was replaced. Review the preview, then confirm and convert.`,
    );
  } catch (error) {
    if (currentOperation !== operation) return;
    setStage(
      audioUrl ? "complete" : "failed",
      `${error instanceof Error ? error.message : "The replacement could not be prepared."} Page ${
        pages.indexOf(page) + 1
      } was not changed. Choose another replacement or retry conversion.`,
    );
  } finally {
    if (currentOperation === operation) {
      preparing = false;
      render();
    }
  }
}

function chooseReplacement(page) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.setAttribute("aria-label", `Choose a replacement for page ${pages.indexOf(page) + 1}`);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) replaceImage(page, file);
  }, { once: true });
  input.click();
}

function movePage(page, offset) {
  const from = pages.indexOf(page);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= pages.length) return;
  stopCurrentOperation();
  pages.splice(to, 0, pages.splice(from, 1)[0]);
  clearAudio();
  setStage("waiting", `Page moved to position ${to + 1}. Review the order, then confirm and convert.`);
}

function removePage(page) {
  const index = pages.indexOf(page);
  if (index < 0) return;
  stopCurrentOperation();
  pages.splice(index, 1);
  if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
  clearAudio();
  setStage(
    "waiting",
    pages.length
      ? `Page ${index + 1} was removed. ${pages.length} ${pages.length === 1 ? "page remains" : "pages remain"}.`
      : "All pages were removed. Add a photo or paste text to begin.",
  );
}

function startOver() {
  if (!pages.length || !window.confirm("Clear all selected pages and audio? This cannot be undone.")) return;
  stopCurrentOperation();
  for (const page of pages) if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
  pages.length = 0;
  recordingNameInput.value = "";
  clearAudio();
  setStage("waiting", "All pages were cleared. Add a photo or paste text to begin again.");
}

async function responseProblem(response, fallback) {
  try {
    if (response.headers.get("content-type")?.includes("application/json")) {
      const problem = await response.json();
      if (problem && typeof problem.message === "string" && problem.message.trim()) {
        return problem.message;
      }
    }
  } catch {
    // Use the status-only fallback for malformed or interrupted error responses.
  }
  return `${fallback} (HTTP ${response.status}).`;
}

function validExtraction(result) {
  return result
    && ["readable", "partial", "unreadable"].includes(result.status)
    && Array.isArray(result.issues)
    && typeof result.confidence === "number"
    && Number.isFinite(result.confidence)
    && result.confidence >= 0
    && result.confidence <= 1
    && typeof result.text === "string"
    && (result.status !== "readable" || result.text.trim());
}

function attentionMessage() {
  const positions = pages
    .map((page, index) => page.extractionState === "readable" && page.text.trim() ? null : index + 1)
    .filter(Boolean);
  return `${positions.length === 1 ? "Page" : "Pages"} ${positions.join(", ")} ${
    positions.length === 1 ? "needs" : "need"
  } attention. Retry, replace, or remove ${positions.length === 1 ? "it" : "them"} before creating audio.`;
}

function applyJob(job) {
  latestJob = job;
  for (const result of job.pages || []) {
    const page = pages.find((item) => item.id === result.id);
    if (!page || !validExtraction(result)) continue;
    page.extractionState = result.status;
    page.text = result.text;
    page.confidence = result.confidence;
    page.issues = result.issues;
  }
  const failedPage = pages.find((page) => page.id === job.failed_page_id);
  if (failedPage) failedPage.extractionState = "failed";

  if (job.status === "complete" && job.recording_id) {
    deleteRecovery(job.id).catch(() => {});
    clearAudio();
    audioUrl = `api/recordings/${encodeURIComponent(job.recording_id)}`;
    audioPlayer.src = audioUrl;
    audioDownload.download = job.name ? `${job.name}.wav` : "textbook-reading.wav";
    audioResult.hidden = false;
    setStage("complete", job.message);
    return true;
  }
  if (job.status === "attention") {
    setStage("attention", pages.length ? attentionMessage() : job.message);
    return true;
  }
  if (job.status === "failed") {
    setStage("failed", job.message);
    return true;
  }
  setStage(job.status === "synthesizing" ? "synthesizing" : "extracting", job.message);
  return false;
}

async function pollJob(jobId, allowMissing = false) {
  let missingAttempts = 0;
  while (activeJobId === jobId) {
    try {
      const response = await fetch(`api/jobs/${encodeURIComponent(jobId)}`);
      if (response.status === 404 && allowMissing && missingAttempts < 10) {
        missingAttempts += 1;
      } else {
        if (!response.ok) throw new Error(await responseProblem(response, "Conversion status could not be loaded"));
        const job = await response.json();
        if (activeJobId !== jobId || applyJob(job)) return;
        missingAttempts = 0;
      }
    } catch (error) {
      if (activeJobId !== jobId) return;
      const unavailable = error instanceof TypeError;
      if (!unavailable || missingAttempts >= 10) {
        setStage(
          "failed",
          "The conversion could not be recovered. Your pages were kept; retry or check Past recordings.",
        );
        return;
      }
      setStage("extracting", "Connection lost. Reconnecting to the conversion...");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
}

async function convert() {
  if (!pages.length || preparing || requestController) return;

  const currentOperation = ++operation;
  requestController = new AbortController();
  const { signal } = requestController;
  const jobId = crypto.randomUUID();
  forgetActiveJob();
  activeJobId = jobId;
  sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);

  try {
    const recordingName = recordingNameInput.value.replace(/\s+/g, " ").trim();
    recordingNameInput.value = recordingName;
    const body = new FormData();
    const manifestPages = pages.map((page) => {
      if (page.kind === "text" || (page.extractionState === "readable" && page.text.trim())) {
        return { id: page.id, kind: "text", text: page.text };
      }
      body.append("images", page.image, "page.jpg");
      return { id: page.id, kind: "image" };
    });
    try {
      await saveRecovery(jobId);
    } catch {
      throw new Error("This browser could not save the pages for recovery. Free some browser storage and try again.");
    }
    body.append("manifest", JSON.stringify({ id: jobId, pages: manifestPages, name: recordingName || null }));
    setStage("extracting", "Uploading pages and starting conversion...");
    const response = await fetch("api/jobs", { method: "POST", body, signal });
    if (!response.ok) throw new Error(await responseProblem(response, "Conversion could not be started"));
    const job = await response.json();
    if (currentOperation !== operation || signal.aborted || activeJobId !== jobId) return;
    requestController = null;
    if (!applyJob(job)) await pollJob(jobId);
  } catch (error) {
    if (currentOperation !== operation || error?.name === "AbortError") return;
    requestController = null;
    if (error instanceof TypeError) {
      setStage("extracting", "Connection lost. Reconnecting to the conversion...");
      await pollJob(jobId, true);
      return;
    }
    forgetActiveJob();
    setStage("failed", error instanceof Error ? error.message : "Conversion could not be started.");
  } finally {
    if (currentOperation === operation) {
      requestController = null;
      render();
    }
  }
}

function handlePageAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const page = pages.find((item) => item.id === button.closest("[data-page-id]")?.dataset.pageId);
  if (!page) return;

  if (button.dataset.action === "move-up") movePage(page, -1);
  if (button.dataset.action === "move-down") movePage(page, 1);
  if (button.dataset.action === "replace") chooseReplacement(page);
  if (button.dataset.action === "crop") openCrop(page);
  if (button.dataset.action === "duplicate") duplicatePage(page);
  if (button.dataset.action === "remove") removePage(page);
  if (button.dataset.action === "retry") convert();
}

photoInput.addEventListener("change", addImages);
cameraButton.addEventListener("click", () => cameraInput.click());
cameraInput.addEventListener("change", addImages);
addTextButton.addEventListener("click", addText);
pageList.addEventListener("click", handlePageAction);
convertButton.addEventListener("click", () => convert());
retryButton.addEventListener("click", () => convert());
clearButton.addEventListener("click", startOver);
cropControls.addEventListener("input", renderCrop);
cropReset.addEventListener("click", () => {
  for (const input of cropInputs) input.value = 0;
  renderCrop();
});
cropCancel.addEventListener("click", () => cropDialog.close());
cropApply.addEventListener("click", applyCrop);
cropDialog.addEventListener("cancel", (event) => {
  if (preparing) event.preventDefault();
});
cropDialog.addEventListener("close", () => closeCrop(true));
window.addEventListener("unload", () => {
  requestController?.abort();
  closeCrop();
  for (const page of pages) if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
  clearAudio();
});

async function start() {
  cleanupRecovery().catch(() => {});
  if (activeJobId) {
    await restoreRecovery(activeJobId).catch(() => {});
    setStage("extracting", "Reconnecting to the previous conversion...");
    pollJob(activeJobId, true);
  } else {
    render();
  }
}

start();
window.setInterval(renderProgress, 1000);
