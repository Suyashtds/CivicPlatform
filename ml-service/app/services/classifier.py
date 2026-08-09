"""
EfficientNet-B0 civic-issue image classifier.

Follows the same ML_MODE convention already used elsewhere in this
service (see ml-service/.env.example):
  - ML_MODE=trained -> loads a fine-tuned EfficientNet-B0 checkpoint from
    IMAGE_MODEL_PATH and runs real inference. Fails loudly at first call
    if the checkpoint is missing.
  - ML_MODE=demo (default) -> no checkpoint required. Uses a deterministic
    image-heuristic stand-in (color/texture profile) so the rest of the
    pipeline (trust score, routing, email) is fully testable without a
    trained model. Every response is tagged inference_mode="demo_fallback".
"""
from __future__ import annotations

import os
from typing import List

import numpy as np
from PIL import Image

CLASSES = [
    "garbage", "pothole", "waterlogging", "streetlight",
    "sewage", "illegal_dumping", "road_damage", "other",
]

ML_MODE = os.getenv("ML_MODE", "demo")
IMAGE_MODEL_PATH = os.getenv("IMAGE_MODEL_PATH", "./models/efficientnet_b0.pth")
CONFIDENCE_REVIEW_THRESHOLD = float(os.getenv("MIN_IMAGE_CLASSIFICATION_CONFIDENCE", "0.70"))

_model = None
_device = None
_transform = None


def _lazy_load_trained_model():
    """Loads torchvision EfficientNet-B0 with a replaced classifier head
    sized for CLASSES, then loads fine-tuned weights from IMAGE_MODEL_PATH.
    Only imported/loaded when ML_MODE=trained, so `torch`/`torchvision`
    are optional dependencies in demo mode."""
    global _model, _device, _transform
    if _model is not None:
        return

    import torch
    from torchvision import models, transforms

    if not os.path.exists(IMAGE_MODEL_PATH):
        raise RuntimeError(
            f"ML_MODE=trained but no checkpoint found at {IMAGE_MODEL_PATH}. "
            f"Either place a fine-tuned EfficientNet-B0 state_dict there or "
            f"set ML_MODE=demo."
        )

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    model = models.efficientnet_b0(weights=None)
    in_features = model.classifier[1].in_features
    model.classifier[1] = torch.nn.Linear(in_features, len(CLASSES))

    state_dict = torch.load(IMAGE_MODEL_PATH, map_location=_device)
    model.load_state_dict(state_dict)
    model.eval()
    model.to(_device)

    _transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])
    _model = model


def _trained_inference(img: Image.Image) -> dict:
    import torch

    _lazy_load_trained_model()
    tensor = _transform(img.convert("RGB")).unsqueeze(0).to(_device)

    with torch.no_grad():
        logits = _model(tensor)
        probs = torch.nn.functional.softmax(logits, dim=1)[0]

    top3_idx = torch.topk(probs, k=min(3, len(CLASSES))).indices.tolist()
    top3 = [{"label": CLASSES[i], "confidence": round(float(probs[i]), 4)} for i in top3_idx]

    best = top3[0]
    return {
        "issue_type": best["label"],
        "confidence": best["confidence"],
        "top3": top3,
        "inference_mode": "trained",
    }


def _demo_inference(img: Image.Image) -> dict:
    """
    Deterministic stand-in used when no trained checkpoint is configured.
    Buckets the image by dominant color / edge-density profile into one
    of the civic categories so downstream trust-score/routing logic has
    something real to branch on during local/demo runs.
    """
    arr = np.array(img.convert("RGB").resize((128, 128)), dtype=np.float64)
    r, g, b = arr[:, :, 0].mean(), arr[:, :, 1].mean(), arr[:, :, 2].mean()
    brightness = (r + g + b) / 3
    gray = np.array(img.convert("L").resize((128, 128)), dtype=np.float64)
    edge_density = float(np.abs(np.diff(gray, axis=0)).mean() + np.abs(np.diff(gray, axis=1)).mean())

    # Deterministic heuristic bucket — not a trained model, only for demo use.
    if b > r and b > g and brightness > 90:
        scores = {"waterlogging": 0.74, "sewage": 0.12, "other": 0.14}
    elif g > r and g > b:
        scores = {"illegal_dumping": 0.40, "garbage": 0.38, "other": 0.22}
    elif edge_density > 18:
        scores = {"pothole": 0.55, "road_damage": 0.30, "other": 0.15}
    elif brightness < 60:
        scores = {"streetlight": 0.52, "other": 0.30, "sewage": 0.18}
    else:
        scores = {"garbage": 0.45, "other": 0.35, "road_damage": 0.20}

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    top3 = [{"label": label, "confidence": round(conf, 4)} for label, conf in ranked[:3]]
    best = top3[0]

    return {
        "issue_type": best["label"],
        "confidence": best["confidence"],
        "top3": top3,
        "inference_mode": "demo_fallback",
    }


def classify_image(img: Image.Image) -> dict:
    """Main entry point. Adds `needs_manual_review` when confidence is low."""
    result = _trained_inference(img) if ML_MODE == "trained" else _demo_inference(img)
    result["needs_manual_review"] = result["confidence"] < CONFIDENCE_REVIEW_THRESHOLD
    return result
