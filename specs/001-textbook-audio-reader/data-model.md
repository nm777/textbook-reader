# Data Model: Textbook Audio Reader

Page-processing entities exist only in the current browser tab. Completed audio files persist on the local server for seven days without a database.

## Conversion Session

Represents the user's current ordered set of pages and its conversion result.

| Field | Type | Rules |
|-------|------|-------|
| `pages` | ordered `PagePhoto[]` | 0-20 selected or duplicated entries while editing; 1-20 to start extraction |
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

Any page edit after completion discards and revokes the browser's old recording URL, returning the session to `waiting`; the server copy remains available for seven days.

## Page Photo

Represents one selected page and its local OCR outcome.

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Stable, tab-local unique identifier |
| `name` | string | Original display name; used only in the browser UI |
| `previewUrl` | object URL | Created once and revoked when the page leaves the session |
| `source` | JPEG blob | Immutable upright normalized full image; may be shared by duplicate entries |
| `crop` | edge-trim object | Independent top, right, bottom, and left percentages; zero means untrimmed |
| `image` | JPEG blob | Derived from `source` and `crop`; at most 4 MiB and never upscaled |
| `position` | integer | Derived from array order; contiguous and 1-based in the UI |
| `extractionState` | enum | `ready`, `extracting`, `readable`, `partial`, `unreadable`, or `failed` |
| `text` | string | Non-empty only when OCR returned usable content |
| `confidence` | number | Mean retained-line confidence from 0 to 1; 0 when no text was found |
| `issues` | `PageIssue[]` | Empty for `readable`; bounded local OCR issue vocabulary otherwise |
| `error` | `Problem` or absent | Transport, validation, model-loading, or inference failure for this page |

### Validation Rules

- Accept at most 20 pages cumulatively across file-picker actions.
- Insert duplicates after their source with a fresh ID, blank OCR result, and independent crop metadata.
- Keep crop bounds inside the source with at least 50 pixels of width and height; cancelling changes nothing.
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

Represents the completed local speech response retained by the browser and the server's seven-day download copy.

| Field | Type | Rules |
|-------|------|-------|
| `blob` | WAV blob | 24 kHz mono PCM written by SoundFile |
| `url` | object URL | Used by both native playback and download; revoked when discarded |
| `filename` | string | `textbook-reading.wav` |
| `duration` | number | Seconds reported by the media element after metadata loads |
| `size` | integer | Response bytes; displayed before download when useful |
| `id` | UUID | Opaque server-side download identifier |
| `created_at` | datetime | Filesystem creation timestamp presented in the user's locale |
| `expires_at` | datetime | Seven days after creation |

During synthesis, the server owns one temporary WAV path. A completed file receives an opaque ID, is available through the recordings endpoint, and is deleted after seven days; failed synthesis files are deleted immediately.

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
- Duplicate `PagePhoto` entries may share one immutable source blob while owning separate crops and preview URLs.
- Each `PagePhoto` has at most one current `ExtractedText` result.
- A `ConversionSession` has at most one `AudioRecording` derived from all currently ordered readable page texts.
- Editing a page invalidates the current `AudioRecording`; successful retry replaces only that page's extraction result.
- Closing or refreshing the tab releases all browser entities. Every endpoint releases request buffers; completed audio remains server-side for seven days.
