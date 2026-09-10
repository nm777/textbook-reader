# textbook-reader Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-09-10

## Active Technologies
- Python 3.12; browser-native HTML, CSS, and JavaScript + FastAPI, Uvicorn, python-multipart, Pillow, PaddleOCR 3.7 with PP-OCRv6 medium, PaddlePaddle, Kokoro 0.9.4, NumPy, and SoundFile (001-textbook-audio-reader)
- No database or object storage; tab-scoped browser memory and request-scoped temporary WAV files deleted after responses complete (001-textbook-audio-reader)

## Project Structure

```text
reader/
scripts/
```

## Commands

python scripts/self_check.py && python -m compileall reader scripts

## Code Style

Python 3.12 and browser-native JavaScript: Follow standard conventions

## Recent Changes
- 001-textbook-audio-reader: Added Python 3.12 with local PaddleOCR text extraction and Kokoro speech generation in one FastAPI service

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
