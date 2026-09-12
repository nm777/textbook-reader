# Feature Specification: Textbook Audio Reader

**Feature Branch**: `001-textbook-audio-reader`
**Created**: 2026-09-10
**Status**: Draft
**Input**: User description: "Build a small, primarily mobile web app that accepts one or more photos of textbook pages, lets the user put them in order, extracts their text, and converts it to audio for in-browser or offline playback."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Turn Page Photos Into Audio (Priority: P1)

As a reader using a phone, I want to select or take photos of textbook pages and convert them into spoken audio so I can listen instead of reading from the page.

**Why this priority**: This end-to-end conversion is the core value of the product and provides a useful result even when pages are already selected in the correct order.

**Independent Test**: Select one clear textbook-page photo, confirm it, complete conversion, and play the resulting audio from beginning to end.

**Acceptance Scenarios**:

1. **Given** a user has selected one clear page photo, **When** the user confirms the page and starts conversion, **Then** the page's readable text is converted into a playable recording.
2. **Given** a conversion is in progress, **When** its status changes, **Then** the user can tell whether it is waiting, processing, complete, or failed.
3. **Given** a conversion has completed, **When** the user selects play, pause, or a different playback position, **Then** playback responds accordingly and shows current progress.

---

### User Story 2 - Arrange And Crop Multiple Pages (Priority: P2)

As a reader processing several pages or columns, I want to duplicate, crop, and rearrange page photos before conversion so the audio follows the textbook's reading order.

**Why this priority**: Mobile photo selection does not always preserve the intended order, and incorrect order makes multi-page audio difficult to follow.

**Independent Test**: Select a two-column page, duplicate it, crop each entry to one column, convert, and verify that the recording reads only those columns in the displayed order.

**Acceptance Scenarios**:

1. **Given** multiple photos have been selected, **When** their previews appear, **Then** each photo has a clear position in the current reading order.
2. **Given** three photos are in the wrong order, **When** the user rearranges and confirms them, **Then** the extracted text and audio follow the confirmed order.
3. **Given** photos are awaiting confirmation, **When** the user adds or removes a photo, **Then** the remaining photos and their order are updated before conversion.
4. **Given** a photo contains multiple columns, **When** the user duplicates it and independently crops and arranges the entries, **Then** only each retained region is extracted and spoken in displayed order.

---

### User Story 3 - Listen Offline (Priority: P3)

As a reader, I want to download a completed recording so I can listen later without returning to the app or relying on a network connection.

**Why this priority**: In-browser playback satisfies the primary use case; downloading extends it to travel, unreliable connections, and the device's usual audio player.

**Independent Test**: Start with one completed conversion, download it, disconnect the device from the network, and play the full recording with the device's standard audio playback capability.

**Acceptance Scenarios**:

1. **Given** a conversion has completed, **When** the user requests a download, **Then** a single playable recording containing all confirmed pages is saved to the device.
2. **Given** no conversion has completed, **When** the user views the session, **Then** no misleading or unusable download is offered.

### Edge Cases

- If no photos are selected, conversion cannot start and the user is told to add at least one page.
- If a photo is unsupported, unreadable, blank, badly cropped, or too blurry to extract useful text, the affected page is identified and the user can replace, remove, or retry it.
- Photos with different orientations are presented and read upright when their intended orientation can be determined; otherwise, the affected photo is identified for replacement.
- If one page fails during a multi-page conversion, the app does not present the result as complete and identifies the page that needs attention.
- If processing is interrupted, no corrupt recording is offered; the user can retry without rebuilding the confirmed page order while the session remains open.
- If selecting or duplicating would exceed 20 page entries, the app keeps the current selection unchanged and explains the limit.
- Cancelling a crop leaves the page and audio unchanged; applying or resetting it clears that page's extraction and the current browser audio.
- Multi-column layouts may be spoken imperfectly when left intact. Users can duplicate and crop a photo into ordered regions, but column boundaries are not inferred automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let users select existing page photos or capture new page photos from a supported mobile or desktop device.
- **FR-002**: The system MUST accept between 1 and 20 ordered page entries; selected photos and duplicates each count as one entry.
- **FR-003**: The system MUST show a preview and an explicit reading-order position for every page entry before conversion.
- **FR-004**: Users MUST be able to add, duplicate, crop, remove, and rearrange page entries before confirming their order.
- **FR-005**: The system MUST begin extraction and audio conversion only after the user confirms the page entries, applied crops, and order.
- **FR-006**: The system MUST extract readable printed text from each confirmed page entry's applied crop and combine it in the confirmed order.
- **FR-007**: The system MUST account for common phone-photo orientation so text is processed in its intended upright orientation when that orientation can be determined.
- **FR-008**: The system MUST convert the combined extracted text into one spoken recording for the session.
- **FR-009**: The system MUST show whether a conversion is waiting, processing, complete, or failed.
- **FR-010**: When a page cannot yield useful text, the system MUST identify that page and provide options to replace, remove, or retry it before presenting a complete recording.
- **FR-011**: Users MUST be able to play, pause, resume, and seek within a completed recording and view playback progress.
- **FR-012**: Users MUST be able to download a completed recording in a form playable by the device's standard audio capability.
- **FR-013**: The system MUST preserve the selected page order when an interrupted conversion is retried during the same open session.
- **FR-014**: The primary capture, ordering, conversion, playback, and download actions MUST be usable on a phone-sized screen without requiring a desktop-only interaction.
- **FR-015**: The system MUST provide clear, actionable feedback when a photo is unsupported, a limit is exceeded, processing fails, or a download cannot be completed.
- **FR-016**: The system MUST keep photos and extracted text in the browser session and retain completed audio on the service for no more than seven days.
- **FR-017**: Users MUST be able to list and redownload recordings that have not expired.
- **FR-018**: Users MUST be able to revise, reset, apply, or cancel a rectangular crop independently for each page entry using touch and keyboard controls.
- **FR-019**: Users MUST be able to duplicate a page entry directly after it with a fresh identity and extraction state.
- **FR-020**: Users MUST be able to give a recording an optional name during creation and change or remove that name from recording history.

### Key Entities

- **Conversion Session**: A temporary unit of work containing selected pages, their confirmed order, processing status, any page-specific problems, and the resulting recording.
- **Page Photo**: One ordered entry containing a normalized source image, independent crop, derived preview, position, and extraction status; duplicates may share the immutable source.
- **Extracted Text**: The readable content obtained from one or more page photos and combined according to the confirmed order.
- **Audio Recording**: The spoken result of a completed conversion, including playback duration, current playback position, and download availability.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of first-time users can select a page photo, convert it, and begin playback on a phone without assistance.
- **SC-002**: A user can select, confirm, and start converting a single existing page photo in under 60 seconds, excluding processing time.
- **SC-003**: A user can reorder five selected page photos into a specified sequence in under 30 seconds on a phone-sized screen.
- **SC-004**: Across a test set of at least 20 clear, upright photos of standard printed textbook prose, at least 95% of words are spoken correctly and in reading order.
- **SC-005**: In at least 9 of 10 timed trials, a 10-page session of clear photos containing no more than 500 printed words per page produces a playable result within 5 minutes.
- **SC-006**: Once conversion is complete, playback begins within 3 seconds of the user's play action in at least 95% of attempts.
- **SC-007**: In 20 completed test conversions, every recording can be played from beginning to end in the app and after download using the test device's standard audio capability.
- **SC-008**: In a usability check, users rate the mobile capture-to-playback flow at least 4 out of 5 for ease of use.
- **SC-009**: In at least 9 of 10 representative two-column trials, the recording reads the user-defined column crops in displayed order without reading excluded text.

## Assumptions

- The project is for one person's private use, so accounts, sign-in, permissions, sharing, and multi-user collaboration are out of scope.
- A conversion session is temporary. Refreshing or closing it discards photos and browser results; completed recordings remain available from the service for seven days.
- In-browser playback is the default outcome, and download is the only required offline capability.
- The first release supports photographed pages containing primarily printed text in one language at a time. Handwriting, translation, and specialized interpretation of formulas, tables, or complex layouts are out of scope.
- Users are responsible for clear, well-lit source photos containing all desired text; cropping cannot recover content omitted from the source.
- Importing document files, editing extracted text, choosing voices, and changing speech speed are out of scope.
- Conversion and recording history require a network connection; only a previously downloaded recording is expected to work offline.
