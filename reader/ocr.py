"""Small, explicitly initialized adapter for local PaddleOCR inference."""

from functools import cache
from os import getenv
from statistics import fmean
from typing import Any, Iterable, Literal, Mapping, TypedDict


class ExtractionResult(TypedDict):
    status: Literal["readable", "partial", "unreadable"]
    issues: list[Literal["low_confidence", "no_text"]]
    confidence: float
    text: str


class OCR:
    def __init__(self, model: Any, min_confidence: float) -> None:
        self._model = model
        self._min_confidence = min_confidence

    def extract(self, image: Any) -> ExtractionResult:
        return _parse_results(self._model.predict(image), self._min_confidence)


@cache
def load_ocr() -> OCR:
    """Load one PP-OCRv6 medium pipeline on first explicit invocation."""
    from paddleocr import PaddleOCR

    device = getenv("PADDLE_DEVICE", "cpu").strip()
    if not device:
        raise ValueError("PADDLE_DEVICE must not be empty")

    raw_confidence = getenv("OCR_MIN_CONFIDENCE", "0.65")
    try:
        min_confidence = float(raw_confidence)
    except ValueError as error:
        raise ValueError("OCR_MIN_CONFIDENCE must be a number from 0 to 1") from error
    if not 0 <= min_confidence <= 1:
        raise ValueError("OCR_MIN_CONFIDENCE must be a number from 0 to 1")

    model = PaddleOCR(
        text_detection_model_name="PP-OCRv6_medium_det",
        text_recognition_model_name="PP-OCRv6_medium_rec",
        use_doc_orientation_classify=True,
        use_doc_unwarping=True,
        use_textline_orientation=True,
        text_rec_score_thresh=0.0,
        device=device,
    )
    return OCR(model, min_confidence)


def _parse_results(
    results: Iterable[Mapping[str, Any]], min_confidence: float
) -> ExtractionResult:
    lines: list[str] = []
    scores: list[float] = []
    for result in results:
        for text, score in zip(
            result["rec_texts"], result["rec_scores"], strict=True
        ):
            text = text.strip()
            if text:
                lines.append(text)
                scores.append(float(score))

    if not lines:
        return {
            "status": "unreadable",
            "issues": ["no_text"],
            "confidence": 0.0,
            "text": "",
        }

    confidence = fmean(scores)
    if any(score < min_confidence for score in scores):
        return {
            "status": "partial",
            "issues": ["low_confidence"],
            "confidence": confidence,
            "text": "\n".join(lines),
        }
    return {
        "status": "readable",
        "issues": [],
        "confidence": confidence,
        "text": "\n".join(lines),
    }
