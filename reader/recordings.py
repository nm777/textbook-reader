"""Filesystem-backed recording retention without a metadata database."""

from datetime import UTC, datetime
from pathlib import Path
import time
from typing import TypedDict
from uuid import UUID, uuid4


RETENTION_SECONDS = 7 * 24 * 60 * 60


class RecordingInfo(TypedDict):
    id: str
    name: str | None
    created_at: str
    expires_at: str
    size: int


def _name_path(path: Path) -> Path:
    return path.with_suffix(".name")


def remove(path: Path) -> bool:
    try:
        path.unlink()
        existed = True
    except FileNotFoundError:
        existed = False
    _name_path(path).unlink(missing_ok=True)
    return existed


def delete_expired(directory: Path, now: float | None = None) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    cutoff = (time.time() if now is None else now) - RETENTION_SECONDS
    for path in directory.glob("*.wav"):
        try:
            if path.stat().st_mtime <= cutoff:
                remove(path)
        except FileNotFoundError:
            pass


def set_name(path: Path, name: str | None) -> bool:
    if not path.is_file():
        return False
    name_path = _name_path(path)
    if name is None:
        name_path.unlink(missing_ok=True)
    else:
        name_path.write_text(name, encoding="utf-8")
    if path.is_file():
        return True
    name_path.unlink(missing_ok=True)
    return False


def retain(path: Path, directory: Path, name: str | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{uuid4().hex}.wav"
    path.replace(destination)
    try:
        if not set_name(destination, name):
            raise FileNotFoundError(destination)
    except OSError:
        remove(destination)
        raise
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
        try:
            name = _name_path(path).read_text(encoding="utf-8").strip() or None
        except (OSError, UnicodeError):
            name = None
        created_at = datetime.fromtimestamp(stat.st_mtime, UTC)
        items.append(
            (
                stat.st_mtime,
                {
                    "id": str(recording_id),
                    "name": name,
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
