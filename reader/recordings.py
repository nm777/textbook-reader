"""Filesystem-backed recording retention without a metadata database."""

from datetime import UTC, datetime
from pathlib import Path
import time
from typing import TypedDict
from uuid import UUID, uuid4


RETENTION_SECONDS = 7 * 24 * 60 * 60


class RecordingInfo(TypedDict):
    id: str
    created_at: str
    expires_at: str
    size: int


def delete_expired(directory: Path, now: float | None = None) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    cutoff = (time.time() if now is None else now) - RETENTION_SECONDS
    for path in directory.glob("*.wav"):
        try:
            if path.stat().st_mtime <= cutoff:
                path.unlink()
        except FileNotFoundError:
            pass


def retain(path: Path, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{uuid4().hex}.wav"
    path.replace(destination)
    return destination


def list_recordings(directory: Path, now: float | None = None) -> list[RecordingInfo]:
    delete_expired(directory, now)
    items: list[tuple[float, RecordingInfo]] = []
    for path in directory.glob("*.wav"):
        try:
            recording_id = UUID(path.stem)
            stat = path.stat()
        except (FileNotFoundError, ValueError):
            continue
        created_at = datetime.fromtimestamp(stat.st_mtime, UTC)
        items.append(
            (
                stat.st_mtime,
                {
                    "id": str(recording_id),
                    "created_at": created_at.isoformat(),
                    "expires_at": datetime.fromtimestamp(
                        stat.st_mtime + RETENTION_SECONDS, UTC
                    ).isoformat(),
                    "size": stat.st_size,
                },
            )
        )
    return [
        item for _, item in sorted(items, key=lambda entry: entry[0], reverse=True)
    ]
