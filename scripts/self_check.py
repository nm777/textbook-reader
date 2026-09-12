"""Minimal model-independent API and static-shell smoke checks."""

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
        fresh = retain(pending, Path(directory), "Existing recording")
        stale = Path(directory) / "00000000000000000000000000000000.wav"
        stale.write_bytes(b"stale")
        stale.with_suffix(".name").write_text("Expired recording")
        now = time.time()
        os.utime(fresh, (now - 60, now - 60))
        os.utime(stale, (now - RETENTION_SECONDS - 1,) * 2)

        saved = list_recordings(Path(directory), now)
        assert UUID(saved[0]["id"]).hex == fresh.stem
        assert saved[0]["name"] == "Existing recording"
        assert saved[0]["size"] == len(b"fresh")
        assert not stale.exists()
        assert not stale.with_suffix(".name").exists()

        reader_app.RECORDINGS_DIR = Path(directory)
        reader_app.load_ocr = lambda: object()
        reader_app.tts.initialize_pipeline = lambda: None

        def synthesize_pages(texts, output_directory):
            assert list(texts) == ["Readable text"]
            generated = Path(output_directory) / "generated.wav"
            generated.write_bytes(b"speech")
            return generated

        reader_app.tts.synthesize_pages = synthesize_pages
        with TestClient(reader_app.app) as client:
            home = client.get("/")
            assert home.status_code == 200
            assert all(
                marker in home.text
                for marker in (
                    'data-action="crop"',
                    'data-action="duplicate"',
                    'id="crop-dialog"',
                    'id="recording-name"',
                )
            )
            assert client.get("/recordings/").status_code == 200
            response = client.get("/api/recordings")
            assert response.status_code == 200
            assert response.json()["recordings"][0]["id"] == saved[0]["id"]
            download = client.get(f"/api/recordings/{saved[0]['id']}")
            assert download.status_code == 200
            assert download.content == b"fresh"
            assert client.get(f"/api/recordings/{UUID(int=0)}").status_code == 404

            speech = client.post(
                "/api/speech",
                json={
                    "name": "  Chapter\n One  ",
                    "pages": [{"id": "page-1", "text": "Readable text"}],
                },
            )
            assert speech.status_code == 200
            assert speech.content == b"speech"
            created = client.get("/api/recordings").json()["recordings"][0]
            assert created["name"] == "Chapter One"
            name_path = Path(directory) / f"{UUID(created['id']).hex}.name"
            assert name_path.read_text() == "Chapter One"
            assert client.patch(
                f"/api/recordings/{created['id']}", json={"name": "Renamed"}
            ).status_code == 204
            assert client.get("/api/recordings").json()["recordings"][0]["name"] == "Renamed"
            assert client.patch(
                f"/api/recordings/{created['id']}", json={"name": "x" * 101}
            ).status_code == 413
            assert client.patch(
                f"/api/recordings/{created['id']}", json={"name": "  "}
            ).status_code == 204
            assert not name_path.exists()
            assert client.patch(
                f"/api/recordings/{UUID(int=0)}", json={"name": "Missing"}
            ).status_code == 404
            assert client.delete(f"/api/recordings/{created['id']}").status_code == 204

            deleted = client.delete(f"/api/recordings/{saved[0]['id']}")
            assert deleted.status_code == 204
            assert not fresh.exists()
            assert not fresh.with_suffix(".name").exists()
            assert client.delete(f"/api/recordings/{saved[0]['id']}").status_code == 404

    print("self-check passed")


if __name__ == "__main__":
    main()
