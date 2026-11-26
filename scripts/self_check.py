"""Minimal model-independent API and static-shell smoke checks."""

from io import BytesIO
from pathlib import Path
import json
import os
import sys
import tempfile
from threading import Event
import time
from types import SimpleNamespace
from uuid import UUID
import wave

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

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

        progress = []
        original_pipeline = reader_app.tts._pipeline
        reader_app.tts._pipeline = lambda text, voice: iter([
            SimpleNamespace(graphemes="First", audio=chunks[0]),
            SimpleNamespace(graphemes="Second", audio=chunks[1]),
        ])
        try:
            generated = reader_app.tts.synthesize_pages(
                ["FirstSecond"], directory,
                lambda done, total: progress.append((done, total)),
            )
            assert progress == [(5, 11), (11, 11)]
            remove_wav(generated)
        finally:
            reader_app.tts._pipeline = original_pipeline

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
        class FakeOcr:
            def extract(self, pixels):
                assert pixels.shape == (1, 1, 3)
                return {
                    "status": "readable",
                    "text": "Readable text",
                    "confidence": 1,
                    "issues": [],
                }

        reader_app.load_ocr = FakeOcr
        reader_app.tts.initialize_pipeline = lambda: None

        audio_started = Event()
        finish_audio = Event()

        def synthesize_pages(texts, output_directory, progress=None):
            assert list(texts) == ["Readable text"]
            if progress is not None:
                progress(6, 13)
                audio_started.set()
                assert finish_audio.wait(5), "Timed out waiting to inspect conversion progress"
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
                    'id="text-input"',
                    'id="add-text-button"',
                    'id="progress-bar"',
                    'id="progress-details"',
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

            job_id = "11111111-1111-1111-1111-111111111111"
            jpeg = BytesIO()
            Image.new("RGB", (1, 1), "white").save(jpeg, "JPEG")
            manifest = json.dumps(
                {
                    "id": job_id,
                    "name": "Recovered job",
                    "pages": [{"id": "page-1", "kind": "image"}],
                }
            )
            started = client.post(
                "/api/jobs",
                data={"manifest": manifest},
                files={"images": ("page.jpg", jpeg.getvalue(), "image/jpeg")},
            )
            assert started.status_code == 202
            try:
                assert audio_started.wait(5)
                job = client.get(f"/api/jobs/{job_id}").json()
                assert job["status"] == "synthesizing"
                assert 20 < job["progress_percent"] < 100
                assert job["remaining_seconds"] > 0
            finally:
                finish_audio.set()
            for _ in range(100):
                job = client.get(f"/api/jobs/{job_id}").json()
                if job["status"] == "complete":
                    break
                time.sleep(0.01)
            assert job["status"] == "complete"
            assert job["progress_percent"] == 100
            assert job["remaining_seconds"] == 0
            assert job["name"] == "Recovered job"
            assert client.post("/api/jobs", data={"manifest": manifest}).json() == job
            recovered = client.get(f"/api/recordings/{job['recording_id']}")
            assert recovered.status_code == 200
            assert recovered.content == b"speech"

    print("self-check passed")


if __name__ == "__main__":
    main()
