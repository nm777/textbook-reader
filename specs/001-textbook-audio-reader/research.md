# Research: Textbook Audio Reader

**Date**: 2026-09-10

## Local Application Shape

**Decision**: Use one Python 3.12 FastAPI process to serve a plain HTML/CSS/JavaScript frontend and run both OCR and speech inference locally.

**Rationale**: PaddleOCR and Kokoro both provide maintained Python libraries. Keeping them in one long-lived process loads each model once and avoids a Node/Python bridge, subprocess startup per page, a second server, CORS, and a frontend build tool. FastAPI provides multipart parsing, binary file responses, application lifespan model setup, and background cleanup with little application code.

**Alternatives considered**: Keeping Next.js would require a separate persistent Python inference service or repeated command execution. Running both models in the phone browser would require large model downloads and impose avoidable memory and inference load on the primary mobile device.

## Stateless Conversion Flow

**Decision**: Keep the conversion session in browser memory. Extract each confirmed page through `POST /api/extract`, retain successful text locally, and call `POST /api/speech` only after every retained page is readable.

**Rationale**: Per-page extraction gives page-specific progress and lets the user replace or retry one failed photo without repeating successful work. Two stateless endpoints remain smaller than a server-side session, queue, polling protocol, database, or object store.

**Alternatives considered**: One end-to-end endpoint has fewer routes but must redo successful pages after a late failure. Persistent asynchronous jobs are unnecessary for one private user and conflict with temporary-session scope.

## Page Image Handling

**Decision**: Let users choose multiple images and optionally invoke the rear camera through native file inputs. In the browser, decode orientation, downscale without upscaling to a 2,400 px long edge, and encode JPEG at approximately 90% quality before preview and upload. Accept originals up to 20 MiB and normalized JPEGs up to 4 MiB. Decode again with Pillow at the server boundary.

**Rationale**: Phone photos can be much larger than OCR needs and may use HEIC. Browser normalization bakes displayed orientation into supported JPEG pixels and limits transfer size; server decoding verifies that untrusted bytes are a valid image. PaddleOCR then applies document orientation classification, text-image unwarping, and text-line orientation correction for photographed pages.

**Alternatives considered**: Sending originals increases memory use and complicates HEIC support. Handwritten deskew, sharpening, and threshold filters can damage characters and are deferred until representative photos show a measurable benefit.

## Text Extraction

**Decision**: Use PaddleOCR 3.7's local PP-OCRv6 medium pipeline with document orientation classification, document unwarping, and text-line orientation enabled. Preserve the pipeline's detected line order and return recognized text, mean line confidence, and a bounded status. Expose `OCR_MIN_CONFIDENCE`, default `0.65`, as the one calibration setting.

**Rationale**: PP-OCRv6 medium is Apache-licensed, supports CPU inference, and balances accuracy with a modest model footprint. Its preprocessing modules directly address rotated and warped phone photos. A page is `unreadable` when no nonblank text is found, `partial` when any retained line falls below the configured confidence threshold, and `readable` otherwise. The threshold remains configurable because confidence behavior must be calibrated against the user's actual textbooks and camera.

**Alternatives considered**: Tesseract is simpler but generally weaker on photographed and distorted pages. PP-StructureV3 and PaddleOCR-VL 1.6 better handle complex columns, formulas, and tables but consume more resources than the first release needs. Add PP-StructureV3 only if the representative-page benchmark shows reading-order failures on common books.

## Speech And Download

**Decision**: Use Kokoro 0.9.4 with the American English pipeline and `af_heart` voice by default. Pass the ordered page text to its generator, let Kokoro split the input at paragraph boundaries, and append each generated 24 kHz audio array to one temporary WAV through SoundFile. Return that file and delete it after the response completes.

**Rationale**: Kokoro is an Apache-licensed 82M-parameter model designed for local inference. Its generator already yields bounded audio segments, and SoundFile can append them directly to one valid seekable WAV without manual headers, FFmpeg, or holding the full recording in memory. Language and voice stay configurable because they must match.

**Alternatives considered**: `kokoro-js` can run in a browser, but even its quantized model is roughly 90 MB before runtime assets and generation competes with image processing on the phone. A compressed final format requires a codec; WAV is the dependency-free first release and can be replaced with one MP3 encoding step if phone storage measurements require it.

## Mobile Ordering And Playback

**Decision**: Render previews in an ordered list with native Move up, Move down, and Remove buttons, controls at least 44 CSS pixels high, a visible page count, status announcements, and native `<audio controls>`. Use stable IDs and object URLs, revoking each URL when replaced, removed, or discarded.

**Rationale**: Buttons work with touch, mouse, keyboard, and assistive technology and satisfy the required non-drag alternative for sortable interfaces. Native media controls provide play, pause, resume, seek, and progress with less code than a custom player.

**Alternatives considered**: Drag-and-drop is less reliable on phones and still needs button alternatives. A sortable-list package and custom audio controls add code without improving the required workflow.

## Privacy, Errors, And Local Access

**Decision**: Bind the service to the local network only, set `Cache-Control: no-store`, avoid logging images/text/audio, and return structured retryable errors. Keep uploads in request memory and speech only in a temporary file removed after transfer.

**Rationale**: No page content or audio needs to leave the host. The first model downloads require internet access, but inference is offline after model caches are populated. Restricting the service to a trusted LAN or private overlay network avoids adding accounts while preventing other users from consuming local compute or viewing active content.

**Alternatives considered**: Public deployment would require authentication, rate limiting, and stronger isolation. Browser-only inference improves host independence but shifts large downloads and compute to the phone. Persistent storage is unnecessary for tab-scoped sessions.

## Sources

- [PaddleOCR repository and Apache 2.0 license](https://github.com/PaddlePaddle/PaddleOCR)
- [PP-OCRv6 pipeline and preprocessing modules](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html)
- [Kokoro Python library and Apache 2.0 license](https://github.com/hexgrad/kokoro)
- [Kokoro JavaScript and quantized model options](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)
- [FastAPI application lifespan](https://fastapi.tiangolo.com/advanced/events/)
- [FastAPI background tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)
- [MDN file input](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file)
- [MDN `createImageBitmap`](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)
- [WCAG dragging alternatives](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
- [MDN audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/audio)
