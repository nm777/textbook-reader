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
   python3 -m pip install -e .
   ```

3. Optionally override the startup settings. The service reads these once while loading the models, so restart it after changing a value.

   | Environment variable | Default | Meaning |
   |----------------------|---------|---------|
   | `OCR_MIN_CONFIDENCE` | `0.65` | Number from 0 through 1. A page is partial if any retained OCR line is below this threshold. |
   | `PADDLE_DEVICE` | `cpu` | Device string passed to PaddleOCR; it must be nonblank and valid for the installed PaddlePaddle build. |
   | `KOKORO_LANGUAGE` | `a` | Kokoro language code (`a` is American English). A blank value also uses `a`. |
   | `KOKORO_VOICE` | `af_heart` | Kokoro voice name. A blank value also uses `af_heart`. |
   | `RECORDINGS_DIR` | `~/.local/share/textbook-reader/recordings` | Directory for completed WAV files retained for seven days. |

   For example, the defaults can be set explicitly with:

   ```bash
   export OCR_MIN_CONFIDENCE=0.65
   export PADDLE_DEVICE=cpu
   export KOKORO_LANGUAGE=a
   export KOKORO_VOICE=af_heart
   ```

4. For host-only use, start exactly one worker:

   ```bash
   python3 -m uvicorn reader.main:app --host 127.0.0.1 --port 8000 --workers 1
   ```

   To test from a phone on the same trusted LAN, expose it on the host's network interfaces instead:

   ```bash
   python3 -m uvicorn reader.main:app --host 0.0.0.0 --port 8000 --workers 1
   ```

   Do not add `--reload` or increase the worker count. Each worker would load its own model copies, while the conversion lock coordinates only requests inside one process. This release supports one private user and one active conversion.

5. On the first startup, wait while PaddleOCR and Kokoro initialize and download their model files. The libraries keep those files in their per-user caches; the application does not copy or delete model caches. Start later runs as the same OS user to reuse them. Once both caches are populated, startup and inference can work without internet access. If either model cannot load, the service still starts, but its affected API returns `503 model_unavailable`; fix the startup setting, dependency, network, or cache and restart.

6. Open `http://localhost:8000` on the host or `http://HOST-LAN-IP:8000` on a phone connected to the same trusted network.

Selected normalized source JPEGs, crops, and OCR text live in the browser tab until their pages are replaced or removed, or the tab is refreshed or closed. Duplicate entries share an immutable source without another upload until conversion. The completed browser audio blob is discarded after any page edit or when the tab ends. An upload exists only for its request and is closed after being read. Completed WAV files remain in `RECORDINGS_DIR` (default `~/.local/share/textbook-reader/recordings`) for redownload from the Past recordings page and are automatically deleted after seven days. A WAV explicitly downloaded to the phone is persistent and must be deleted by the user when no longer wanted.

## Docker Setup

The CPU container needs no camera, audio, or GPU device access. The phone browser captures photos and receives the generated WAV over HTTP.

Build the image:

```bash
docker build -t textbook-reader .
```

Run it with one persistent model-cache volume and about 16 GB of memory available:

```bash
docker run --rm --name textbook-reader \
  -p 8000:8000 \
  -v textbook-reader-models:/home/reader/.cache \
  -v textbook-reader-recordings:/home/reader/recordings \
  textbook-reader
```

The first start downloads the PaddleOCR and Kokoro models into `textbook-reader-models`; later containers reuse them. Completed recordings use the separate `textbook-reader-recordings` volume and expire after seven days. Open `http://localhost:8000` on the host or `http://HOST-LAN-IP:8000` from a phone on the same trusted LAN. The image targets Linux `amd64` CPU execution; GPU use requires a different PaddlePaddle package and container runtime and is not part of this setup.

### Docker Compose and private Traefik

The Compose configuration builds the app, reuses the model-cache and recording volumes, and connects it to the existing `traefik_web` network. It does not publish the app port. Traefik accepts only loopback, private-network, and Tailscale client addresses for this route.

The LAN dnsdist resolver at `192.168.0.91` provides `morris.private A 192.168.0.111`. Clients receiving that resolver through DHCP need no hosts-file entry. An `/etc/hosts` entry on a client is only a fallback when it does not use the LAN resolver:

```text
192.168.0.111 morris.private
```

Build and start the app:

```bash
docker compose up --build -d
```

Open `https://morris.private/textbook-reader/`. The existing Traefik redirects HTTP to HTTPS globally. Since public certificate authorities cannot issue a certificate for `.private`, clients must trust the proxy's local certificate; alternatively, install a private-CA certificate in the shared Traefik configuration. Use `docker compose logs -f app` to follow the initial model downloads and `docker compose down` to stop the app without deleting its model or recording volumes.

## Smoke Check

Compile the Python sources, then run the model-independent assertion script:

```bash
python3 -m compileall reader scripts
python3 scripts/self_check.py
```

The assertion script requires the installed `numpy` and `SoundFile` packages plus the system `libsndfile` library. It verifies the crop/duplicate shell, ordered text assembly, incremental 24 kHz mono WAV writing, recording retention, and seven-day expiration without loading PaddleOCR or Kokoro. A missing-module or shared-library error means the declared setup dependency is absent; it is separate from live-model acceptance.

With the service running, smoke-check the page and both live routes. The OCR input here must already be a valid JPEG no larger than 4 MiB or 2,400 px on its longest edge; the browser normally performs that normalization.

```bash
curl -fsS -o /dev/null http://127.0.0.1:8000/
curl -fsS -F 'image=@page.jpg;type=image/jpeg' http://127.0.0.1:8000/api/extract | python3 -m json.tool
curl -fsS -H 'Content-Type: application/json' \
  --data '{"pages":[{"id":"smoke-page","text":"Textbook reader smoke check."}]}' \
  -o textbook-reading.wav http://127.0.0.1:8000/api/speech
```

The final command deliberately saves a client-side WAV; play it and remove it after the check. These live commands exercise the cached models and are not covered by `self_check.py`.

## Mobile Acceptance Flow

1. Start the one-worker LAN command on the host. On a physical phone connected to that trusted LAN, open `http://HOST-LAN-IP:8000`; confirm the gallery picker and rear-camera action work without a desktop-only interaction.
2. Select one clear representative textbook page. Confirm its preview is upright, its position is `Page 1`, the count says one page, and no playback or download is offered. Time selection, confirmation, and the start of conversion; the target is under 60 seconds, excluding processing. Confirm the announced sequence covers waiting, extracting, synthesizing, and complete.
3. Play the recording from beginning to end. Pause, resume, seek to another position, and confirm native playback progress updates. Across repeated attempts, playback must begin within three seconds of pressing play after audio is ready at least 95% of the time.
4. Select five clearly numbered representative pages in the wrong order, using more than one picker action. Confirm every preview, position, filename, and extraction state is visible and upright.
5. Time use of Move up and Move down to reach a specified order; the five-page reorder target is under 30 seconds. Remove one page, add it again, replace another, and confirm positions remain contiguous and the count follows each edit.
6. Select a representative two-column page and choose Duplicate. Crop one entry to each column using touch and keyboard controls; cancel once to confirm no change, then apply both crops. Reopen and reset one crop to confirm it restores the full source.
7. Confirm and convert. Verify page-by-page extraction progress is announced and the columns are spoken once in displayed order. During a retry, confirm already-readable unchanged pages are not extracted again.
8. Include a blank, badly blurred, or otherwise low-confidence page. Confirm the result enters attention rather than offering audio, identifies its page position, and offers Retry, Replace, and Remove. Use each recovery path in turn and confirm synthesis starts only when every retained page is readable.
9. Interrupt one extraction, then use the page Retry or conversion Retry control. Interrupt speech synthesis, then use conversion Retry. Confirm the current page order and successful OCR results remain available, and no incomplete recording or download is offered.
10. After successful multi-page conversion, play, pause, resume, seek, and listen through page boundaries. Confirm the recording matches the visible order.
11. Confirm the download link appears only after completion. Download `textbook-reading.wav`, disconnect the phone from the LAN, and play the whole file in the phone's standard audio player.
12. Reconnect and make each kind of page edit: add, replace, crop, duplicate, remove, and move. After each edit, confirm the old player and download disappear and a new conversion is required. Refresh the tab and confirm the temporary selection and result are discarded.
13. Run ten timed 10-page trials with no more than 500 printed words per page on the target host. At least nine must produce a playable result within five minutes. Across 20 completed representative conversions, verify every in-browser and downloaded WAV plays from beginning to end.
14. Run the complete phone flow with first-time users. At least 90% must select a page, convert it, and begin playback without assistance, and the average ease-of-use rating must be at least 4 out of 5.

## Limit And Failure Checks

- With zero pages, confirm `Confirm and convert` is disabled and playback/download remain hidden.
- With an existing selection, choose enough files in one picker action to exceed 20 total. Confirm none from that action are added, the existing selection is unchanged, and the message says how many must be removed.
- At 20 entries, choose Duplicate and confirm the limit is announced without changing the session.
- Move crop edges until fewer than 50 pixels remain and confirm Apply is unavailable and the validation is announced.
- In the browser, try an original over 20 MiB, an undecodable or unsupported image, and an image whose normalized JPEG exceeds 4 MiB. Confirm each is rejected without changing an existing page. Send a valid JPEG over 2,400 px directly to `/api/extract` and confirm the API rejects it with `413`.
- Send `/api/speech` zero pages, 21 pages, blank text, and combined text over 100,000 characters. Confirm it returns a structured `400` or `413` problem and no WAV.
- Test EXIF-rotated, sideways, badly cropped, blank, and badly blurred pages. Confirm supported orientation is displayed upright and unreadable or partial results identify the affected position instead of producing audio.
- Interrupt extraction and speech requests separately. Confirm retry keeps the order and completed OCR, and no corrupt or stale WAV is exposed.
- To check startup failure handling, stop the service, make one required model unavailable in a controlled test environment, and restart. Confirm the affected route returns `503 model_unavailable` without page text, cache paths, or filesystem details. Restore the model and restart; changing a cache after successful startup does not affect the already-loaded model.
- Compare at least 20 clear, upright representative textbook photos against their source text and spoken reading order. The target is at least 95% of words spoken correctly; calibrate `OCR_MIN_CONFIDENCE` if partial-page detection is too strict or lenient. Include normal prose plus the columns, captions, tables, formulas, and page furniture common in the intended books, noting that specialized interpretation is out of scope.

## Local Access Boundary

`--host 0.0.0.0` exposes an unauthenticated HTTP service, including page uploads and generated audio, to networks allowed by the host firewall. Use it only on a trusted LAN or a private overlay network, and stop the service after phone testing. Do not forward port 8000, expose it through a public tunnel, or place it on an untrusted network; public access requires authentication, TLS, request limiting, and stronger isolation that this release does not provide.

Keep `--workers 1` and one active conversion. If the five-minute target is missed on CPU, record the host and timings before considering a supported accelerator or a smaller PaddleOCR model tier; neither alternative is part of this implementation's acceptance baseline.
