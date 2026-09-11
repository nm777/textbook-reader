"""Minimal smoke check for model-independent text-to-WAV helpers."""

from pathlib import Path
import os
import sys
import tempfile
import time
from uuid import UUID
import wave

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reader import main as reader_app
from reader.recordings import RETENTION_SECONDS, list_recordings, retain
from reader.tts import assemble_page_text, remove_wav, write_wav


def main() -> None:
    assert assemble_page_text(
        ["  First page\nline two\n\nNew paragraph  ", "\tSecond page\n"]
    ) == (
        "First page line two\n\nNew paragraph\n\nSecond page"
    )

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "smoke.wav"
        chunks = (
            np.array([0.0, 0.25, -0.25], dtype=np.float32),
            np.array([0.5, -0.5], dtype=np.float32),
        )
        try:
            write_wav(path, chunks)
            assert path.stat().st_size > 0
            with wave.open(str(path), "rb") as wav:
                assert (
                    wav.getframerate(),
                    wav.getnchannels(),
                    wav.getsampwidth(),
                    wav.getcomptype(),
                ) == (24_000, 1, 2, "NONE")
                assert wav.getnframes() == sum(map(len, chunks))
        finally:
            remove_wav(path)
        assert not path.exists()

        pending = Path(directory) / "pending.wav"
        pending.write_bytes(b"fresh")
        fresh = retain(pending, Path(directory))
        stale = Path(directory) / "00000000000000000000000000000000.wav"
        stale.write_bytes(b"stale")
        now = time.time()
        os.utime(fresh, (now - 60, now - 60))
        os.utime(stale, (now - RETENTION_SECONDS - 1,) * 2)

        saved = list_recordings(Path(directory), now)
        assert UUID(saved[0]["id"]).hex == fresh.stem
        assert saved[0]["size"] == len(b"fresh")
        assert not stale.exists()

        reader_app.RECORDINGS_DIR = Path(directory)
        reader_app.load_ocr = lambda: object()
        reader_app.tts.initialize_pipeline = lambda: None
        with TestClient(reader_app.app) as client:
            assert client.get("/recordings/").status_code == 200
            response = client.get("/api/recordings")
            assert response.status_code == 200
            assert response.json()["recordings"][0]["id"] == saved[0]["id"]
            download = client.get(f"/api/recordings/{saved[0]['id']}")
            assert download.status_code == 200
            assert download.content == b"fresh"
            assert client.get(f"/api/recordings/{UUID(int=0)}").status_code == 404

    print("self-check passed")


if __name__ == "__main__":
    main()
