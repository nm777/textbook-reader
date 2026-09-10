# Data Model: Textbook Audio Reader

All user-facing entities are temporary and exist only in the current browser tab or one local server request. There is no persistent data model.

## Conversion Session

Represents the user's current ordered set of pages and its conversion result.

| Field | Type | Rules |
|-------|------|-------|
| `pages` | ordered `PagePhoto[]` | 0-20 while editing; 1-20 to start extraction |
| `stage` | enum | `waiting`, `extracting`, `attention`, `synthesizing`, `complete`, or `failed` |
| `currentPage` | integer or absent | 1-based position shown during extraction |
| `audio` | `AudioRecording` or absent | Present only at `complete` |
| `error` | `Problem` or absent | Present when the session has a non-page-specific failure |

### State Transitions

```text
waiting ──confirm──> extracting ──all readable──> synthesizing ──success──> complete
   ▲                     │                              │
   │                     ├──page issue──> attention ───┘ after replace/remove/retry
   │                     └──request error──> failed
   └──────────── edit/retry from attention or failed ────────────┘
```

Any page edit after completion discards and revokes the old recording, returning the session to `waiting`.

## Page Photo

Represents one selected page and its local OCR outcome.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable, tab-local unique identifier |
| `name` | string | Original display name; used only in the browser UI |
| `previewUrl` | object URL | Created once and revoked when the page leaves the session |
| `image` | JPEG blob | Upright, at most 4 MiB, at most 2,400 px on its longest edge, never upscaled |
| `position` | integer | Derived from array order; contiguous and 1-based in the UI |
| `extractionState` | enum | `ready`, `extracting`, `readable`, `partial`, `unreadable`, or `failed` |
| `text` | string | Non-empty only when OCR returned usable content |
| `confidence` | number | Mean retained-line confidence from 0 to 1; 0 when no text was found |
| `issues` | `PageIssue[]` | Empty for `readable`; bounded local OCR issue vocabulary otherwise |
| `error` | `Problem` or absent | Transport, validation, model-loading, or inference failure for this page |

### Validation Rules

- Accept at most 20 pages cumulatively across file-picker actions.
- Reject originals over 20 MiB before browser normalization.
- Decode the normalized image with Pillow rather than trusting its extension or declared media type.
- Reject a normalized image over 4 MiB, over 2,400 px on its longest edge, or not encoded as JPEG.
- Reordering changes only array order and derived positions; it does not recreate IDs or object URLs.
- `partial`, `unreadable`, and `failed` pages block speech generation until replaced, removed, or successfully retried.

## Extracted Text

Represents one page's structured local OCR result.

| Field | Type | Rules |
|-------|------|-------|
| `status` | enum | `readable`, `partial`, or `unreadable` |
| `issues` | `PageIssue[]` | Values: `low_confidence` or `no_text` |
| `confidence` | number | Arithmetic mean of retained line scores; 0 if no lines remain |
| `text` | string | Detected text in the OCR pipeline's reading order |

The configurable `OCR_MIN_CONFIDENCE` threshold defaults to `0.65`. A result containing any retained line below the threshold is `partial`; an empty result is `unreadable`; all other results are `readable`. The threshold must be calibrated with representative pages rather than treated as a universal accuracy guarantee.

The combined speech input is derived, not stored separately: trim each readable page, preserve its internal line breaks, and join pages in current order with two newline characters. The combined input must contain 1-100,000 characters.

## Audio Recording

Represents the completed local speech response retained by the browser.

| Field | Type | Rules |
|-------|------|-------|
| `blob` | WAV blob | 24 kHz mono PCM written by SoundFile |
| `url` | object URL | Used by both native playback and download; revoked when discarded |
| `filename` | string | `textbook-reading.wav` |
| `duration` | number | Seconds reported by the media element after metadata loads |
| `size` | integer | Response bytes; displayed before download when useful |

During synthesis, the server owns one temporary WAV path. It is never exposed as a reusable URL and is deleted after the file response completes or immediately if synthesis fails.

## Problem

Represents an actionable validation, local inference, or network error.

| Field | Type | Rules |
|-------|------|-------|
| `code` | string | Stable machine-readable value from the API contract |
| `message` | string | Safe user-facing explanation; contains no filesystem paths or page text |
| `retryable` | boolean | Whether retrying unchanged input can reasonably succeed |
| `pageId` | string or absent | Browser-added association for a page-specific request |

## Relationships And Lifecycle

- A `ConversionSession` contains 0-20 ordered `PagePhoto` entities.
- Each `PagePhoto` has at most one current `ExtractedText` result.
- A `ConversionSession` has at most one `AudioRecording` derived from all currently ordered readable page texts.
- Editing a page invalidates the current `AudioRecording`; successful retry replaces only that page's extraction result.
- Closing or refreshing the tab releases all browser entities. Every endpoint releases request buffers, and speech generation removes its temporary file after transfer.
