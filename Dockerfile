FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_DEVICE=cpu \
    PADDLE_PDX_CACHE_HOME=/home/reader/.cache/paddlex \
    HF_HOME=/home/reader/.cache/huggingface

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
COPY reader/ reader/
COPY scripts/ scripts/
RUN python -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu torch \
    && python -m pip install --no-cache-dir . \
    && python scripts/self_check.py \
    && useradd --create-home --uid 10001 reader \
    && mkdir -p /home/reader/.cache \
    && chown -R reader:reader /home/reader
RUN python -m spacy download en_core_web_sm

USER reader

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "reader.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
