"""FastAPI application for local textbook OCR and speech synthesis."""

import asyncio
from contextlib import asynccontextmanager, suppress
from io import BytesIO
from os import getenv
from pathlib import Path
import time
from typing import Annotated, Literal
from uuid import UUID

import numpy as np
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError

from reader import recordings, tts
from reader.ocr import load_ocr


MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_EDGE = 2_400
MAX_RECORDING_NAME_LENGTH = 100
STATIC_DIR = Path(__file__).with_name("static")
RECORDINGS_DIR = Path(
    getenv("RECORDINGS_DIR") or "~/.local/share/textbook-reader/recordings"
).expanduser()
_inference_lock = asyncio.Lock()


class SpeechPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    text: str = Field(min_length=1)

    @field_validator("id", "text")
    @classmethod
    def require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pages: list[SpeechPage] = Field(min_length=1, max_length=20)
    name: str | None = Field(default=None, max_length=MAX_RECORDING_NAME_LENGTH)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return None if value is None else (" ".join(value.split()) or None)

    @model_validator(mode="after")
    def enforce_combined_text_limit(self) -> "SpeechRequest":
        try:
            tts.assemble_page_text(page.text for page in self.pages)
        except tts.TextTooLongError as error:
            raise PydanticCustomError(
                "combined_text_too_large",
                "Combined page text cannot exceed 100,000 characters",
            ) from error
        return self


class ConversionPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    kind: Literal["image", "text"]
    text: str = ""

    @model_validator(mode="after")
    def require_text(self) -> "ConversionPage":
        if self.kind == "text" and not self.text.strip():
            raise ValueError("text pages must not be blank")
        return self


class ConversionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    pages: list[ConversionPage] = Field(min_length=1, max_length=20)
    name: str | None = Field(default=None, max_length=MAX_RECORDING_NAME_LENGTH)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return None if value is None else (" ".join(value.split()) or None)


class RecordingNameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(max_length=MAX_RECORDING_NAME_LENGTH)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        return None if value is None else (" ".join(value.split()) or None)


class ImageTooLargeError(ValueError):
    pass


class InvalidImageError(ValueError):
    pass


class UnsupportedImageError(ValueError):
    pass


def _problem(
    status_code: int,
    code: Literal[
        "invalid_request",
        "invalid_image",
        "too_large",
        "unsupported_image",
        "inference_failure",
        "model_unavailable",
        "not_found",
    ],
    message: str,
    retryable: bool = False,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message, "retryable": retryable},
    )


def _decode_jpeg(data: bytes) -> np.ndarray:
    try:
        with Image.open(BytesIO(data)) as image:
            if image.format != "JPEG":
                raise UnsupportedImageError
            if max(image.size) > MAX_IMAGE_EDGE:
                raise ImageTooLargeError
            image.load()
            return np.array(image.convert("RGB"), copy=True)
    except Image.DecompressionBombError as error:
        raise ImageTooLargeError from error
    except UnidentifiedImageError as error:
        if data.startswith(b"\xff\xd8\xff"):
            raise InvalidImageError from error
        raise UnsupportedImageError from error
    except OSError as error:
        raise InvalidImageError from error


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ocr = None
    app.state.ocr_load_error = None
    app.state.tts_load_error = None
    app.state.jobs = {}
    app.state.job_tasks = set()

    await asyncio.to_thread(recordings.delete_expired, RECORDINGS_DIR)
    cleanup_task = asyncio.create_task(_remove_expired_recordings())
    try:
        try:
            app.state.ocr = await asyncio.to_thread(load_ocr)
        except Exception as error:
            app.state.ocr_load_error = error

        try:
            await asyncio.to_thread(tts.initialize_pipeline)
        except Exception as error:
            app.state.tts_load_error = error

        yield
    finally:
        cleanup_task.cancel()
        for task in app.state.job_tasks:
            task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        if app.state.job_tasks:
            await asyncio.gather(*app.state.job_tasks, return_exceptions=True)


async def _remove_expired_recordings() -> None:
    while True:
        await asyncio.sleep(60 * 60)
        await asyncio.to_thread(recordings.delete_expired, RECORDINGS_DIR)
        cutoff = time.time() - recordings.RETENTION_SECONDS
        app.state.jobs = {
            job_id: job
            for job_id, job in app.state.jobs.items()
            if job["created_at"] > cutoff or job["status"] not in {"complete", "attention", "failed"}
        }


def _update_job(job: dict, status: str, message: str, **values) -> None:
    job.update(status=status, message=message, **values)
    if status == "complete":
        job.update(progress_percent=100, remaining_seconds=0)
    elif status in {"attention", "failed"}:
        job["remaining_seconds"] = None


def _job_progress(job: dict, percent: float, remaining: float) -> None:
    job.update(
        progress_percent=min(99, round(percent)),
        remaining_seconds=max(1, round(remaining)),
        progress_updated_at=time.time(),
    )


async def _run_conversion_job(
    job_id: str, request: ConversionRequest, image_data: list[bytes]
) -> None:
    job = app.state.jobs[job_id]
    results = []
    images = iter(image_data)
    path = None
    current_page_id = None
    image_count = sum(page.kind == "image" for page in request.pages)
    extracted_images = 0
    extraction_seconds = 0
    # ponytail: rough cold-start rates; measured job throughput replaces them as work finishes.
    seconds_per_image = 15
    seconds_per_character = 0.05
    audio_weight = 80 if image_count else 100
    estimated_characters = sum(len(page.text) for page in request.pages) + image_count * 2000
    loop = asyncio.get_running_loop()
    try:
        for position, page in enumerate(request.pages, 1):
            current_page_id = page.id
            _update_job(
                job,
                "extracting",
                f"Extracting text from page {position} of {len(request.pages)}...",
                pages=results,
            )
            if page.kind == "text":
                result = {
                    "id": page.id,
                    "status": "readable",
                    "text": page.text,
                    "confidence": 1,
                    "issues": [],
                }
            else:
                pixels = await asyncio.to_thread(_decode_jpeg, next(images))
                job["remaining_seconds"] = None
                async with _inference_lock:
                    _job_progress(
                        job, job["progress_percent"],
                        (image_count - extracted_images) * seconds_per_image
                        + estimated_characters * seconds_per_character,
                    )
                    started = time.monotonic()
                    extracted = await asyncio.to_thread(app.state.ocr.extract, pixels)
                    extraction_seconds += time.monotonic() - started
                extracted_images += 1
                seconds_per_image = extraction_seconds / extracted_images
                result = {"id": page.id, **extracted}
            results.append(result)
            characters = sum(len(item["text"]) for item in results)
            remaining_images = image_count - extracted_images
            estimated_characters = characters + remaining_images * (
                characters / len(results) if results else 2000
            ) + sum(len(item.text) for item in request.pages[position:] if item.kind == "text")
            _job_progress(
                job,
                (100 - audio_weight) * extracted_images / max(1, image_count),
                remaining_images * seconds_per_image + estimated_characters * seconds_per_character,
            )
            current_page_id = None

        job["pages"] = results
        unreadable = [index + 1 for index, page in enumerate(results) if page["status"] != "readable"]
        if unreadable:
            label = "Page" if len(unreadable) == 1 else "Pages"
            _update_job(
                job,
                "attention",
                f"{label} {', '.join(map(str, unreadable))} need attention before audio can be created.",
            )
            return

        _update_job(job, "synthesizing", f"Creating audio from {len(results)} page{'s' if len(results) != 1 else ''}...")
        job["remaining_seconds"] = None
        async with _inference_lock:
            _job_progress(job, 100 - audio_weight, characters * seconds_per_character)
            started = time.monotonic()

            def audio_progress(completed: int, total: int) -> None:
                elapsed = time.monotonic() - started
                remaining = (total - completed) * elapsed / max(1, completed)
                loop.call_soon_threadsafe(
                    _job_progress, job,
                    100 - audio_weight + audio_weight * completed / total,
                    remaining,
                )

            path = await asyncio.to_thread(
                tts.synthesize_pages,
                (page["text"] for page in results),
                RECORDINGS_DIR,
                audio_progress,
            )
            path = await asyncio.to_thread(recordings.retain, path, RECORDINGS_DIR, request.name)
        recording_id = str(UUID(path.stem))
        _update_job(
            job,
            "complete",
            f"{len(results)} page{'s are' if len(results) != 1 else ' is'} complete. Use the audio controls to listen.",
            recording_id=recording_id,
            name=request.name,
        )
    except (ImageTooLargeError, InvalidImageError, UnsupportedImageError) as error:
        messages = {
            ImageTooLargeError: "A page image exceeds the supported size.",
            InvalidImageError: "A page image could not be decoded.",
            UnsupportedImageError: "A page upload is not a valid JPEG image.",
        }
        _update_job(
            job,
            "failed",
            messages[type(error)],
            pages=results,
            failed_page_id=current_page_id,
        )
    except tts.TextTooLongError:
        if path is not None:
            tts.remove_wav(path)
        _update_job(job, "failed", "Combined page text cannot exceed 100,000 characters.", pages=results)
    except Exception:
        if path is not None:
            tts.remove_wav(path)
        _update_job(
            job,
            "failed",
            "Conversion failed. Retry the conversion.",
            pages=results,
            failed_page_id=current_page_id,
        )


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def prevent_caching(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def request_validation_problem(
    request: Request, error: RequestValidationError
) -> JSONResponse:
    too_large = any(
        item["type"] in {"too_long", "string_too_long", "combined_text_too_large"}
        for item in error.errors()
    )
    if too_large:
        return _problem(
            413,
            "too_large",
            "The request exceeds an application limit.",
        )
    return _problem(
        400,
        "invalid_request",
        "The request is missing required or valid data.",
    )


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/recordings/", include_in_schema=False)
async def recordings_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "recordings.html")


@app.get("/api/recordings")
async def saved_recordings() -> JSONResponse:
    items = await asyncio.to_thread(recordings.list_recordings, RECORDINGS_DIR)
    return JSONResponse({"recordings": items})


@app.get("/api/recordings/{recording_id}")
async def download_recording(recording_id: UUID):
    await asyncio.to_thread(recordings.delete_expired, RECORDINGS_DIR)
    path = RECORDINGS_DIR / f"{recording_id.hex}.wav"
    if not path.is_file():
        return _problem(404, "not_found", "The recording was not found or has expired.")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"textbook-reading-{recording_id.hex[:8]}.wav",
        content_disposition_type="attachment",
    )


@app.delete("/api/recordings/{recording_id}", status_code=204)
async def delete_recording(recording_id: UUID):
    path = RECORDINGS_DIR / f"{recording_id.hex}.wav"
    if not await asyncio.to_thread(recordings.remove, path):
        return _problem(404, "not_found", "The recording was not found or has expired.")
    return Response(status_code=204)


@app.patch("/api/recordings/{recording_id}", status_code=204)
async def name_recording(recording_id: UUID, body: RecordingNameRequest):
    path = RECORDINGS_DIR / f"{recording_id.hex}.wav"
    if not await asyncio.to_thread(recordings.set_name, path, body.name):
        return _problem(404, "not_found", "The recording was not found or has expired.")
    return Response(status_code=204)


@app.post("/api/jobs")
async def create_conversion_job(
    manifest: Annotated[str, Form()],
    images: Annotated[list[UploadFile], File()] = [],
) -> JSONResponse:
    try:
        request = ConversionRequest.model_validate_json(manifest)
    except ValidationError:
        return _problem(400, "invalid_request", "The conversion request is invalid.")

    job_id = str(request.id)
    if job_id in app.state.jobs:
        return JSONResponse(app.state.jobs[job_id])
    if sum(page.kind == "image" for page in request.pages) != len(images):
        return _problem(400, "invalid_request", "Each image page must include one upload.")
    if any(page.kind == "image" for page in request.pages) and (
        app.state.ocr_load_error is not None or app.state.ocr is None
    ):
        return _problem(503, "model_unavailable", "The local OCR model is unavailable.")
    if app.state.tts_load_error is not None:
        return _problem(503, "model_unavailable", "The local speech model is unavailable.")

    image_data = []
    try:
        for image in images:
            data = await image.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                return _problem(413, "too_large", "Each image cannot exceed 4 MiB.")
            if not data:
                return _problem(400, "invalid_image", "An uploaded image is empty.")
            image_data.append(data)
    finally:
        for image in images:
            await image.close()

    job = {
        "id": job_id,
        "status": "queued",
        "message": "Conversion is queued...",
        "pages": [],
        "recording_id": None,
        "name": request.name,
        "created_at": time.time(),
        "progress_percent": 0,
        "remaining_seconds": None,
        "progress_updated_at": time.time(),
    }
    app.state.jobs[job_id] = job
    task = asyncio.create_task(_run_conversion_job(job_id, request, image_data))
    app.state.job_tasks.add(task)
    task.add_done_callback(app.state.job_tasks.discard)
    return JSONResponse(job, status_code=202)


@app.get("/api/jobs/{job_id}")
async def conversion_job(job_id: UUID) -> JSONResponse:
    job = app.state.jobs.get(str(job_id))
    if job is None:
        return _problem(404, "not_found", "The conversion job was not found.")
    return JSONResponse(job)


@app.post("/api/extract")
async def extract_page(image: Annotated[UploadFile, File()]) -> JSONResponse:
    if app.state.ocr_load_error is not None or app.state.ocr is None:
        await image.close()
        return _problem(
            503,
            "model_unavailable",
            "The local OCR model is unavailable.",
        )

    try:
        data = await image.read(MAX_IMAGE_BYTES + 1)
    finally:
        await image.close()

    if len(data) > MAX_IMAGE_BYTES:
        return _problem(
            413,
            "too_large",
            "The image cannot exceed 4 MiB.",
        )
    if not data:
        return _problem(400, "invalid_image", "The uploaded image is empty.")

    try:
        pixels = await asyncio.to_thread(_decode_jpeg, data)
    except ImageTooLargeError:
        return _problem(
            413,
            "too_large",
            "The image cannot exceed 2,400 pixels on its longest edge.",
        )
    except UnsupportedImageError:
        return _problem(
            415,
            "unsupported_image",
            "The upload must be a valid JPEG image.",
        )
    except InvalidImageError:
        return _problem(
            400,
            "invalid_image",
            "The JPEG image could not be decoded.",
        )

    try:
        async with _inference_lock:
            result = await asyncio.to_thread(app.state.ocr.extract, pixels)
        return JSONResponse(result)
    except Exception:
        return _problem(
            500,
            "inference_failure",
            "Local text extraction failed.",
            retryable=True,
        )


@app.post("/api/speech")
async def create_speech(body: SpeechRequest):
    if app.state.tts_load_error is not None:
        return _problem(
            503,
            "model_unavailable",
            "The local speech model is unavailable.",
        )

    path = None
    try:
        async with _inference_lock:
            path = await asyncio.to_thread(
                tts.synthesize_pages,
                (page.text for page in body.pages),
                RECORDINGS_DIR,
            )
            path = await asyncio.to_thread(
                recordings.retain, path, RECORDINGS_DIR, body.name
            )
        return FileResponse(
            path,
            media_type="audio/wav",
            filename="textbook-reading.wav",
            content_disposition_type="attachment",
        )
    except tts.TextTooLongError:
        if path is not None:
            tts.remove_wav(path)
        return _problem(
            413,
            "too_large",
            "Combined page text cannot exceed 100,000 characters.",
        )
    except Exception:
        if path is not None:
            tts.remove_wav(path)
        return _problem(
            500,
            "inference_failure",
            "Local speech synthesis failed.",
            retryable=True,
        )


app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR, check_dir=False),
    name="static",
)
