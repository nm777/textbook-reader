# Implementation Plan: Textbook Audio Reader

**Branch**: `001-textbook-audio-reader` | **Date**: 2026-09-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-textbook-audio-reader/spec.md`

## Summary

Build a mobile-first page served by one local Python process. The browser keeps selected textbook photos and their order in tab memory, while local endpoints extract each confirmed page with PaddleOCR and synthesize the ordered text with Kokoro. Both models load once when the service starts; no content leaves the local machine, no paid API credentials are required, and completed speech is returned as one playable and downloadable temporary WAV file.

## Technical Context

**Language/Version**: Python 3.12; browser-native HTML, CSS, and JavaScript
**Primary Dependencies**: FastAPI, Uvicorn, python-multipart, Pillow, PaddleOCR 3.7 with PP-OCRv6 medium, PaddlePaddle, Kokoro 0.9.4, NumPy, and SoundFile
**Storage**: No database or object storage; tab-scoped browser memory and request-scoped temporary WAV files deleted after responses complete
**Testing**: No test framework; one Python `assert` smoke script, Python bytecode compilation, and manual mobile acceptance checks
**Target Platform**: A private local Python service on a modern x86-64 or Apple Silicon computer with 16 GB RAM recommended; current mobile and desktop browsers, with phone-sized screens primary
**Project Type**: Single-process local web application
**Performance Goals**: Complete at least 9 of 10 ten-page trials within 5 minutes on the target host; begin playback within 3 seconds after audio is ready; keep ordering interactions immediate for 20 previews
**Constraints**: 1-20 photos; 20 MiB original-file and 4 MiB normalized-file limits; 2,400 px maximum normalized long edge; 100,000-character combined speech limit; CPU-only operation supported; no external inference calls; no persistent user content; one private user and one active conversion
**Scale/Scope**: One page, two local endpoints, one long-lived model process, no accounts, no saved library, no queue, and no concurrent-user scaling requirement

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

The constitution file contains only unratified template placeholders, so it defines no enforceable principles or gates. Pre-design gate: **PASS**. The plan independently minimizes runtimes and persistence, validates uploaded images, keeps all content local, preserves mobile accessibility, and includes one runnable check for the non-trivial audio-file path.

Post-design re-evaluation: **PASS**. The design remains one process with two necessary interfaces, no database, no queue, no external service, no frontend framework, and no unresolved clarifications. No complexity exceptions are required.

## Project Structure

### Documentation (this feature)

```text
specs/001-textbook-audio-reader/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
└── tasks.md              # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
reader/
├── __init__.py
├── main.py
├── ocr.py
├── tts.py
└── static/
    ├── app.js
    ├── index.html
    └── styles.css
scripts/
└── self_check.py
pyproject.toml
```

**Structure Decision**: Use one FastAPI application that initializes PaddleOCR and Kokoro during application startup, serves the static browser UI, and exposes `/api/extract` and `/api/speech`. Plain browser JavaScript owns the single temporary workflow. Separate `ocr.py` and `tts.py` modules isolate model-specific work and allow the smoke check to cover WAV generation without loading either model.
