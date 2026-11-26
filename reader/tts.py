"""Local Kokoro speech synthesis with temporary WAV output."""

from collections.abc import Callable, Iterable
import os
from pathlib import Path
import re
import tempfile
from typing import Any


SAMPLE_RATE = 24_000
MAX_TEXT_CHARACTERS = 100_000

_pipeline: Any | None = None
_voice = ""


class TextTooLongError(ValueError):
    """Raised when assembled speech text exceeds the application limit."""


def assemble_page_text(pages: Iterable[str]) -> str:
    """Trim and join page text in its supplied order."""
    trimmed_pages = [
        re.sub(
            r"(?<!\n)\n(?!\n)",
            " ",
            page.strip().replace("\r\n", "\n").replace("\r", "\n"),
        )
        for page in pages
    ]
    if not any(trimmed_pages):
        raise ValueError("Speech text must contain at least one character")
    text = "\n\n".join(trimmed_pages)
    if len(text) > MAX_TEXT_CHARACTERS:
        raise TextTooLongError(
            f"Speech text cannot exceed {MAX_TEXT_CHARACTERS} characters"
        )
    return text


def initialize_pipeline() -> None:
    """Load the configured Kokoro pipeline and voice exactly once."""
    global _pipeline, _voice

    if _pipeline is not None:
        return

    language = os.environ.get("KOKORO_LANGUAGE", "a").strip() or "a"
    voice = os.environ.get("KOKORO_VOICE", "af_heart").strip() or "af_heart"

    from kokoro import KPipeline

    pipeline = KPipeline(lang_code=language, repo_id="hexgrad/Kokoro-82M")
    pipeline.load_voice(voice)
    _pipeline = pipeline
    _voice = voice


def write_wav(path: str | os.PathLike[str], audio_chunks: Iterable[Any]) -> Path:
    """Incrementally write audio chunks as a 24 kHz mono PCM WAV."""
    import soundfile

    path = Path(path)
    frame_count = 0
    with soundfile.SoundFile(
        path,
        mode="w",
        samplerate=SAMPLE_RATE,
        channels=1,
        format="WAV",
        subtype="PCM_16",
    ) as wav:
        for audio in audio_chunks:
            if audio is None or len(audio) == 0:
                continue
            wav.write(audio)
            frame_count += len(audio)

    if frame_count == 0:
        raise RuntimeError("Kokoro produced no audio")
    return path


def remove_wav(path: str | os.PathLike[str]) -> None:
    """Remove a temporary WAV, tolerating repeated cleanup."""
    Path(path).unlink(missing_ok=True)


def synthesize_pages(
    pages: Iterable[str],
    directory: str | os.PathLike[str] | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> Path:
    """Synthesize ordered pages into a caller-owned temporary WAV path."""
    text = assemble_page_text(pages)
    if _pipeline is None:
        raise RuntimeError("Kokoro pipeline has not been initialized")

    descriptor, name = tempfile.mkstemp(suffix=".wav", dir=directory)
    os.close(descriptor)
    path = Path(name)
    try:
        results = _pipeline(text, voice=_voice)

        def chunks():
            completed = 0
            for result in results:
                yield result.audio
                if progress is not None:
                    completed += len(result.graphemes)
                    progress(min(completed, len(text)), len(text))

        return write_wav(path, chunks())
    except Exception:
        remove_wav(path)
        raise
