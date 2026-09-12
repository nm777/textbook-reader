"""FastAPI application for local textbook OCR and speech synthesis."""

import asyncio
from contextlib import asynccontextmanager, suppress
from io import BytesIO
from os import getenv
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import numpy as np
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
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
        with suppress(asyncio.CancelledError):
            await cleanup_task


async def _remove_expired_recordings() -> None:
    while True:
        await asyncio.sleep(60 * 60)
        await asyncio.to_thread(recordings.delete_expired, RECORDINGS_DIR)


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
