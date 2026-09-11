---

description: "Executable task list for the textbook audio reader"
---

# Tasks: Textbook Audio Reader

**Input**: Design documents from `/specs/001-textbook-audio-reader/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/openapi.yaml`, `quickstart.md`

**Tests**: The specification does not request a test framework. The plan requires one dependency-free assertion script, bytecode compilation, and manual acceptance checks.

**Subagents**: Run every task in a fresh `general` subagent on the model named in its description. Each subagent must read the design documents relevant to its task and inspect current target files before editing. If a named model is unavailable, use the next stronger tier: `gpt-5.6-luna` -> `gpt-5.6-terra` -> `gpt-5.6-sol`.

**Model policy**: `gpt-5.6-luna` handles deterministic setup, markup, CSS, and small UI changes; `gpt-5.6-terra` handles normal integration and verification; `gpt-5.6-sol` is reserved for model APIs, resource lifecycle, concurrency, and complex browser state.

**Organization**: Tasks are grouped by user story so the MVP can be completed and checked before ordering and download enhancements.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with adjacent tasks because it changes different files and has no unmet dependency
- **[Story]**: Maps implementation work to `US1`, `US2`, or `US3`
- Every task names its subagent model and exact target path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create only the package metadata and package root required by the planned application.

- [X] T001 Delegate to a `general` subagent using `gpt-5.6-luna`: create `pyproject.toml` for Python 3.12 with the planned FastAPI, Uvicorn, multipart, Pillow, PaddleOCR 3.7/PP-OCRv6, PaddlePaddle, Kokoro 0.9.4, NumPy, and SoundFile runtime dependencies, include `reader/static` as package data, and add no test or frontend-build dependencies.
- [X] T002 [P] Delegate to a `general` subagent using `gpt-5.6-luna`: create the minimal Python package marker in `reader/__init__.py` with no eager model imports or speculative public API.

**Checkpoint**: The Python package and dependency manifest match the single-process structure in `plan.md`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Isolate both local inference libraries behind small adapters that load models explicitly once and do not load them during module import.

**CRITICAL**: Complete this phase before implementing the FastAPI application or browser workflow.

- [X] T003 [P] Delegate to a `general` subagent using `gpt-5.6-sol`: implement the PaddleOCR adapter in `reader/ocr.py`, including explicit one-time PP-OCRv6 medium initialization, `PADDLE_DEVICE` and `OCR_MIN_CONFIDENCE` configuration, document orientation/unwarping/text-line orientation options, reading-order text extraction, mean confidence, and exactly the `readable`, `partial`, `unreadable`, `low_confidence`, and `no_text` values defined in `data-model.md`; keep import side effects and content logging out of the module, then run `python -m compileall reader/ocr.py`.
- [X] T004 [P] Delegate to a `general` subagent using `gpt-5.6-sol`: implement the Kokoro adapter and model-independent helpers in `reader/tts.py`, including explicit one-time pipeline initialization from `KOKORO_LANGUAGE` and `KOKORO_VOICE`, ordered page-text assembly with the 100,000-character bound, incremental 24 kHz mono WAV writing through SoundFile, and cleanup-safe synthesis without loading Kokoro at import time; expose the small pure helpers needed by `scripts/self_check.py`, then run `python -m compileall reader/tts.py`.

**Checkpoint**: OCR and speech adapters compile, remain importable without loading model weights, and expose all operations needed by the two API routes.

---

## Phase 3: User Story 1 - Turn Page Photos Into Audio (Priority: P1) MVP

**Goal**: Select or capture one clear textbook page, extract its text locally, create one recording, and play it with visible conversion status.

**Independent Test**: Select one clear page photo, confirm it, complete conversion, and play, pause, seek, and resume the resulting recording from beginning to end.

### Implementation for User Story 1

- [X] T005 [P] [US1] Delegate to a `general` subagent using `gpt-5.6-sol`: implement `reader/main.py` as one FastAPI app that loads both adapters once in lifespan state, keeps one process-local conversion lock, serves `reader/static/index.html` and static assets, adds `Cache-Control: no-store`, and implements `POST /api/extract` plus `POST /api/speech` exactly as `contracts/openapi.yaml` specifies; validate JPEG bytes with Pillow, enforce the 4 MiB/2,400 px and page/text limits, return safe structured errors without content or filesystem paths, stream `textbook-reading.wav`, and delete every temporary WAV after success or failure, then run `python -m compileall reader/main.py`.
- [X] T006 [P] [US1] Delegate to a `general` subagent using `gpt-5.6-luna`: build the semantic single-page shell in `reader/static/index.html` with existing-photo and rear-camera inputs, a page preview region, confirm/convert and retry controls, a visible live status region, native `<audio controls>`, and linked `styles.css` and deferred `app.js`; use explicit labels and keep playback and download controls hidden or disabled until valid.
- [X] T007 [US1] Delegate to a `general` subagent using `gpt-5.6-luna`: implement the mobile-first visual layout in `reader/static/styles.css` for the markup from T006, with readable contrast, visible keyboard focus, responsive previews, status/error treatments, and primary touch targets at least 44 CSS pixels high; use plain CSS with no framework or generated assets.
- [X] T008 [US1] Delegate to a `general` subagent using `gpt-5.6-sol`: implement the one-page browser workflow in `reader/static/app.js`: validate original images up to 20 MiB, decode orientation, downscale without upscaling to a 2,400 px long edge, encode and enforce a JPEG up to 4 MiB, own/revoke preview and audio object URLs, call `/api/extract` then `/api/speech`, preserve the page for retry after interruption, block speech for partial/unreadable OCR, render waiting/extracting/attention/synthesizing/complete/failed states with actionable errors, invalidate stale audio on edits, and connect the result to the native audio element.

**Checkpoint**: User Story 1 works end to end for one page and exposes no download before a successful conversion.

---

## Phase 4: User Story 2 - Arrange Multiple Pages (Priority: P2)

**Goal**: Maintain 1-20 stable page records, let the user review and change their reading order, and synthesize successful page text in that confirmed order.

**Independent Test**: Select three distinctly numbered photos in the wrong order, move them into the correct order, remove and re-add one, convert, and verify the recording follows the displayed positions without reprocessing successful unchanged pages.

### Implementation for User Story 2

- [X] T009 [US2] Delegate to a `general` subagent using `gpt-5.6-luna`: extend `reader/static/index.html` with a visible page count and an ordered-page `<template>` containing preview, derived position, extraction state, Move up, Move down, Replace, Remove, and Retry controls with accessible names.
- [X] T010 [P] [US2] Delegate to a `general` subagent using `gpt-5.6-sol`: extend `reader/static/app.js` from a single page to an ordered array of stable-ID page records, accept cumulative picker/camera additions without changing the current selection when the 20-page limit would be exceeded, implement add/replace/remove/move/retry actions, derive contiguous displayed positions from array order, retain successful OCR across retries, block synthesis until every page is readable, submit page text in confirmed order, and revoke only discarded object URLs.
- [X] T011 [P] [US2] Delegate to a `general` subagent using `gpt-5.6-luna`: style the ordered list and page-card controls added by T009 in `reader/static/styles.css`, keeping page position and state clear on phone screens and making Move up/down a touch, keyboard, and assistive-technology alternative to drag-and-drop; do not add a sortable library or custom drag implementation.

**Checkpoint**: User Stories 1 and 2 work together for 1-20 pages, and page edits invalidate stale audio while preserving the current order.

---

## Phase 5: User Story 3 - Listen Offline (Priority: P3)

**Goal**: Download the completed combined WAV for playback outside the browser and off the local network.

**Independent Test**: Complete a conversion, download `textbook-reading.wav`, disconnect the device from the service, and play the whole file in the device's standard audio player; verify no download is offered before completion or after a page edit.

### Implementation for User Story 3

- [X] T012 [US3] Delegate to a `general` subagent using `gpt-5.6-luna`: add a clearly named download link to `reader/static/index.html` and wire it in `reader/static/app.js` to the completed audio object URL with filename `textbook-reading.wav`, exposing it only in the complete state and clearing it whenever pages or audio change; reuse the playback blob rather than requesting or storing a second recording.

**Checkpoint**: All three stories are functional, and one temporary browser blob supports both native playback and offline download.

---

## Phase 6: Polish and Cross-Cutting Verification

**Purpose**: Leave the smallest runnable regression check and verify the documented local workflow.

- [X] T013 [P] Delegate to a `general` subagent using `gpt-5.6-terra`: implement the dependency-free assertion smoke check in `scripts/self_check.py` using only model-independent helpers from `reader/tts.py`; verify page text is joined in order, an incremental WAV is valid, and its temporary path is removed, without initializing PaddleOCR or Kokoro, then run `python scripts/self_check.py`.
- [X] T014 Delegate to a `general` subagent using `gpt-5.6-terra`: reconcile startup commands, environment names, local model-cache behavior, trusted-LAN warning, smoke commands, limit/failure checks, and the full mobile acceptance flow against the finished implementation in `specs/001-textbook-audio-reader/quickstart.md`; correct only stale instructions, then run `python scripts/self_check.py && python -m compileall reader scripts` and report any acceptance step that still requires physical-phone or representative-textbook validation.

**Checkpoint**: Automated local checks pass and the remaining hardware/content checks are explicit in `quickstart.md`.

---

## Dependencies and Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately; T001 and T002 may run in parallel.
- **Foundational (Phase 2)**: Depends on Setup; T003 and T004 may run in parallel and block application integration.
- **User Story 1 (Phase 3)**: Depends on T003 and T004; T005 and T006 may start in parallel, T007 depends on T006, and T008 depends on T005-T007.
- **User Story 2 (Phase 4)**: Depends on User Story 1; T009 runs first, then T010 and T011 may run in parallel.
- **User Story 3 (Phase 5)**: Depends on User Story 1 and may be completed before User Story 2 if only one-page download is needed; do not run T012 concurrently with T009 or T010 because they edit the same frontend files.
- **Polish (Phase 6)**: T013 depends on T004; T014 depends on every desired story and T013.

### User Story Dependencies

- **User Story 1 (P1)**: The independently deliverable MVP after shared adapters are ready.
- **User Story 2 (P2)**: Extends the US1 browser session from one page to an ordered collection while retaining the same stateless API.
- **User Story 3 (P3)**: Reuses US1's completed audio blob and does not require US2.

### Parallel Examples

```text
After Setup: run T003 on gpt-5.6-sol || T004 on gpt-5.6-sol
After Foundation: run T005 on gpt-5.6-sol || T006 on gpt-5.6-luna
After T009: run T010 on gpt-5.6-sol || T011 on gpt-5.6-luna
After T012 and T004: run T013 on gpt-5.6-terra while physical acceptance preparation proceeds
```

---

## Implementation Strategy

### MVP First

1. Complete T001-T004.
2. Complete T005-T008.
3. Stop and perform the User Story 1 independent test.
4. Add T009-T011 only when multi-page ordering is needed.
5. Add T012 only when offline playback is needed.
6. Finish with T013-T014 for every delivered scope.

### Task Summary

- **Total tasks**: 14
- **Setup tasks**: 2
- **Foundational tasks**: 2
- **User Story 1 tasks**: 4
- **User Story 2 tasks**: 3
- **User Story 3 tasks**: 1
- **Polish tasks**: 2
- **Parallel-capable tasks**: 8
- **Model assignments**: 7 `gpt-5.6-luna`, 2 `gpt-5.6-terra`, 5 `gpt-5.6-sol`

## Notes

- Do not add a database, queue, authentication, external inference, frontend framework, drag library, custom audio player, persistent library, or test framework.
- Keep Uvicorn at one worker and serialize conversion because both local models are process-owned resources.
- Treat image bytes, extracted text, and generated audio as temporary sensitive content and never log them.
- Commit only when explicitly requested; task completion does not imply a commit.
