# Quickstart: Textbook Audio Reader

## Prerequisites

- Python 3.12
- `espeak-ng` and `libsndfile`
- About 16 GB RAM recommended for the local OCR and speech models
- A current phone browser for the primary acceptance check
- Internet access for initial dependency and model downloads only

On Debian or Ubuntu, install system libraries with:

```bash
sudo apt install espeak-ng libsndfile1
```

On macOS with Homebrew:

```bash
brew install espeak-ng libsndfile
```

## Local Setup

1. Create and activate a virtual environment:

   ```bash
   python3.12 -m venv .venv
   source .venv/bin/activate
   ```

2. Install the application and local model dependencies:

   ```bash
   python -m pip install -e .
   ```

3. Optionally override the built-in defaults in the shell before startup:

   ```bash
   export OCR_MIN_CONFIDENCE=0.65
   export PADDLE_DEVICE=cpu
   export KOKORO_LANGUAGE=a
   export KOKORO_VOICE=af_heart
   ```

4. Start the local service and allow the first run to download model weights:

   ```bash
   python -m uvicorn reader.main:app --host 0.0.0.0 --port 8000
   ```

5. Open `http://localhost:8000` on the host or `http://HOST-LAN-IP:8000` on a phone connected to the same trusted network.

After model caches are populated, OCR and speech inference work without internet access. Page photos, extracted text, and audio stay on the local host and browser; the generated WAV exists only until its response completes.

## Smoke Check

Run the dependency-free assertion script and Python compilation check:

```bash
python scripts/self_check.py
python -m compileall reader scripts
```

The assertion script verifies ordered text assembly and temporary WAV writing without loading PaddleOCR or Kokoro.

## Mobile Acceptance Flow

1. Open the app on a phone-sized screen.
2. Choose or photograph five clearly numbered textbook pages in the wrong order.
3. Confirm that all previews are upright and the page count is visible.
4. Use Move up and Move down to place the pages in order, then remove and re-add one page.
5. Start conversion and verify that page-level local OCR progress is announced.
6. If a page is flagged as partial or unreadable, replace or retry it and verify successful pages are not reprocessed.
7. Play, pause, seek, and resume the complete Kokoro recording.
8. Download `textbook-reading.wav`, disconnect the phone from the local network, and play the file with the device's standard player.
9. Confirm that editing any page clears the stale recording and requires a new conversion.

## Limit And Failure Checks

- Attempt conversion with zero pages and verify it remains unavailable.
- Add more than 20 pages and verify the existing selection is unchanged with an actionable message.
- Try a file over 20 MiB, an undecodable image, a rotated page, and a badly blurred page.
- Interrupt an extraction request, retry it, and verify page order is retained.
- Temporarily make a model cache unavailable and verify the page reports a local model error without exposing filesystem details.
- Compare at least 20 representative pages against source text and adjust `OCR_MIN_CONFIDENCE` if partial-page detection is too strict or too lenient.

## Local Access Boundary

Keep the service on a trusted LAN or private overlay network. Do not forward port 8000 to the public internet; public access would require authentication and request limiting. If the five-minute target is missed on CPU, try PaddleOCR's smaller model tier or enable a supported accelerator before adding queues or distributed services.
