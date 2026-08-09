# Model checkpoints

`efficientnet_b0.pth` is **not** committed here — trained weights don't
belong in git and can't be generated as part of this patch.

- With `ML_MODE=demo` (default, see `ml-service/.env.example`), no
  checkpoint is needed — `app/services/classifier.py` uses a
  deterministic image-heuristic fallback so the rest of the pipeline
  (trust score, routing, review queue, email) is fully testable.
- With `ML_MODE=trained`, place your fine-tuned EfficientNet-B0
  `state_dict` here as `efficientnet_b0.pth` (see `IMAGE_MODEL_PATH`
  in `.env`). The classifier head must be sized for the 8 classes in
  `classifier.py::CLASSES`.

To fine-tune one: start from `torchvision.models.efficientnet_b0(weights="IMAGENET1K_V1")`,
replace `model.classifier[1]` with `nn.Linear(in_features, 8)`, and
train on labelled civic-issue photos (garbage / pothole / waterlogging
/ streetlight / sewage / illegal_dumping / road_damage / other).
