"""Minimal smoke check for model-independent text-to-WAV helpers."""

from pathlib import Path
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reader.tts import assemble_page_text, remove_wav, write_wav


def main() -> None:
    assert assemble_page_text(["  First page\nline two  ", "\tSecond page\n"]) == (
        "First page\nline two\n\nSecond page"
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

    print("self-check passed")


if __name__ == "__main__":
    main()
