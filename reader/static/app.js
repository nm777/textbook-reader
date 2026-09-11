"use strict";

const MAX_PAGES = 20;
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const MIN_CROP_EDGE = 50;

const photoInput = document.querySelector("#photo-input");
const cameraButton = document.querySelector("#camera-button");
const cameraInput = document.querySelector("#camera-input");
const pageCount = document.querySelector("#page-count");
const previewEmpty = document.querySelector("#preview-empty");
const pageList = document.querySelector("#page-list");
const pageTemplate = document.querySelector("#page-template");
const convertButton = document.querySelector("#convert-button");
const retryButton = document.querySelector("#retry-button");
const clearButton = document.querySelector("#clear-button");
const status = document.querySelector("#status");
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
let message = "Add a page photo to begin.";
let preparing = false;
let audioUrl = null;
let requestController = null;
let operation = 0;
let nextPageId = 1;
let cropPage = null;
let cropBitmap = null;
let cropReturnPageId = null;

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

    card.dataset.pageId = page.id;
    preview.src = page.previewUrl;
    preview.alt = `Preview of page ${position}: ${page.name}`;
    card.querySelector("[data-page-position]").textContent = position;
    card.querySelector("[data-page-file-name]").textContent = page.name;
    const extractionState = card.querySelector("[data-page-extraction-state]");
    extractionState.dataset.state = page.extractionState;
    extractionState.textContent = extractionLabels[page.extractionState];

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
      if (button.dataset.action === "retry") {
        button.hidden = !["partial", "unreadable", "failed"].includes(page.extractionState);
      }
    }
    return card;
  }));

  convertButton.disabled = !pages.length || busy || stage !== "waiting";
  retryButton.hidden = !pages.length || (stage !== "attention" && stage !== "failed");
  retryButton.disabled = busy;
  clearButton.disabled = !pages.length;
}

function setStage(nextStage, nextMessage) {
  stage = nextStage;
  message = nextMessage;
  render();
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return [
    minutes ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : "",
    seconds ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : "",
  ].filter(Boolean).join(" ");
}

function clearAudio() {
  audioDownload.removeAttribute("href");
  audioDownload.hidden = true;
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
  audioResult.hidden = true;
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
}

function stopCurrentOperation() {
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

function duplicatePage(page) {
  const index = pages.indexOf(page);
  if (index < 0) return;
  if (pages.length >= MAX_PAGES) {
    message = `You can keep up to ${MAX_PAGES} pages. Remove a page before duplicating another.`;
    render();
    return;
  }
  stopCurrentOperation();
  const duplicate = newPage({ name: page.name }, page.source, page.image, page.crop);
  pages.splice(index + 1, 0, duplicate);
  clearAudio();
  setStage("waiting", `Page ${index + 1} was duplicated as page ${index + 2}. Crop each copy, then confirm and convert.`);
  focusCropButton(duplicate.id);
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
  URL.revokeObjectURL(page.previewUrl);
  clearAudio();
  setStage(
    "waiting",
    pages.length
      ? `Page ${index + 1} was removed. ${pages.length} ${pages.length === 1 ? "page remains" : "pages remain"}.`
      : "All pages were removed. Add a page photo to begin.",
  );
}

function startOver() {
  if (!pages.length || !window.confirm("Clear all selected pages and audio? This cannot be undone.")) return;
  stopCurrentOperation();
  for (const page of pages) URL.revokeObjectURL(page.previewUrl);
  pages.length = 0;
  clearAudio();
  setStage("waiting", "All pages were cleared. Add a page photo to begin again.");
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

async function extract(page, currentOperation, signal) {
  const position = pages.indexOf(page) + 1;
  page.extractionState = "extracting";
  page.error = null;
  setStage("extracting", `Extracting text from page ${position} of ${pages.length}...`);

  const body = new FormData();
  body.append("image", page.image, "page.jpg");
  const response = await fetch("api/extract", { method: "POST", body, signal });
  if (!response.ok) {
    throw new Error(await responseProblem(response, `Page ${position} could not be processed`));
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The extraction service returned an unexpected response.");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The extraction service returned an unreadable response.");
  }
  if (!validExtraction(result)) {
    throw new Error("The extraction service returned an invalid response.");
  }
  if (currentOperation !== operation || signal.aborted || !pages.includes(page)) return;

  page.extractionState = result.status;
  page.text = result.text;
  page.confidence = result.confidence;
  page.issues = result.issues;
  render();
}

function attentionMessage() {
  const positions = pages
    .map((page, index) => page.extractionState === "readable" && page.text.trim() ? null : index + 1)
    .filter(Boolean);
  return `${positions.length === 1 ? "Page" : "Pages"} ${positions.join(", ")} ${
    positions.length === 1 ? "needs" : "need"
  } attention. Retry, replace, or remove ${positions.length === 1 ? "it" : "them"} before creating audio.`;
}

async function synthesize(orderedPages, signal) {
  setStage(
    "synthesizing",
    `Creating audio from ${orderedPages.length} ${orderedPages.length === 1 ? "page" : "pages"}...`,
  );
  const response = await fetch("api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages: orderedPages }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await responseProblem(response, "Audio could not be created"));
  }
  if (!response.headers.get("content-type")?.startsWith("audio/")) {
    throw new Error("The speech service returned an unexpected response.");
  }
  const blob = await response.blob();
  if (!blob.size) {
    throw new Error("The speech service returned an empty recording.");
  }
  return blob;
}

async function convert(retryPage = null) {
  if (!pages.length || preparing || requestController || (retryPage && !pages.includes(retryPage))) return;

  const currentOperation = ++operation;
  const startedAt = performance.now();
  requestController = new AbortController();
  const { signal } = requestController;
  let currentPage = null;

  try {
    const pendingPages = retryPage
      ? [retryPage]
      : pages.filter((page) => page.extractionState !== "readable" || !page.text.trim());
    for (const page of pendingPages) {
      currentPage = page;
      await extract(page, currentOperation, signal);
      if (currentOperation !== operation || signal.aborted) return;
      currentPage = null;
    }

    if (pages.some((page) => page.extractionState !== "readable" || !page.text.trim())) {
      setStage("attention", attentionMessage());
      return;
    }

    const orderedPages = pages.map((page) => ({ id: page.id, text: page.text }));
    const recording = await synthesize(orderedPages, signal);
    if (currentOperation !== operation || signal.aborted) return;

    clearAudio();
    audioUrl = URL.createObjectURL(recording);
    audioPlayer.src = audioUrl;
    audioResult.hidden = false;
    setStage(
      "complete",
      `${pages.length} ${pages.length === 1 ? "page is" : "pages are"} complete in ${
        formatDuration(performance.now() - startedAt)
      }. Use the audio controls to play, pause, or seek.`,
    );
  } catch (error) {
    if (currentOperation !== operation || error?.name === "AbortError") return;
    if (currentPage?.extractionState === "extracting") {
      currentPage.extractionState = "failed";
      currentPage.error = error;
    }
    const detail = error instanceof Error ? error.message : "Conversion was interrupted.";
    const retained = currentPage
      ? `Page ${pages.indexOf(currentPage) + 1} was kept. Use its Retry, Replace, or Remove control.`
      : "Extracted page text was kept. Retry conversion.";
    setStage("failed", `${detail} ${retained}`);
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
  if (button.dataset.action === "retry") convert(page);
}

photoInput.addEventListener("change", addImages);
cameraButton.addEventListener("click", () => cameraInput.click());
cameraInput.addEventListener("change", addImages);
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
  for (const page of pages) URL.revokeObjectURL(page.previewUrl);
  clearAudio();
});

render();
