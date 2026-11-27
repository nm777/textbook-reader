# syntax=docker/dockerfile:1

FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_DEVICE=cpu \
    PADDLE_PDX_CACHE_HOME=/home/reader/.cache/paddlex \
    HF_HOME=/home/reader/.cache/huggingface \
    RECORDINGS_DIR=/home/reader/recordings

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        espeak-ng \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -c 'import tomllib; print("\n".join(tomllib.load(open("pyproject.toml", "rb"))["project"]["dependencies"]))' > /tmp/requirements.txt \
    && python -m pip install \
        --index-url https://download.pytorch.org/whl/cpu torch \
    && python -m pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m spacy download en_core_web_sm
RUN useradd --create-home --uid 10001 reader \
    && mkdir -p /home/reader/.cache /home/reader/recordings \
    && chown -R reader:reader /home/reader

COPY reader/ reader/
COPY scripts/self_check.py scripts/self_check.py
RUN python scripts/self_check.py

USER reader

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "reader.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
