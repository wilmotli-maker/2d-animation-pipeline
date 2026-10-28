// src/color-range.js
// The editing/gen pipeline standardizes on limited/tv (mpeg) colour range.
//
// Our source clips are untagged (`color_range=unknown`), and ffmpeg already decodes untagged
// YUV as tv by default. So writing this tag on every re-encode is LEVEL-PRESERVING — it does not
// move a single pixel value, it only makes the already-implicit range explicit. That matters
// because the range was being dropped between stages: the fal model, the harmonize colour conform,
// and the final mux were each left to guess, and a guess that disagrees with how the stills were
// extracted is what produces the gen<->source colour step (a ~10-level shift between a tv- and a
// full-range reading of the same frame).
//
// Rule: respect a source's own tag on the way in (ffmpeg does, defaulting to tv when untagged);
// TAG every encode on the way out with RANGE_ARGS so the range never leaves this pipeline implicit.
// We do not force the range on frame EXTRACTION — ffmpeg's tag-aware default already reads untagged
// sources as tv, and forcing it would mis-decode a source that legitimately arrives tagged full.
export const COLOR_RANGE = 'tv';

// Output-side ffmpeg flags; append right after `-pix_fmt yuv420p` on any libx264 encode.
export const RANGE_ARGS = ['-color_range', COLOR_RANGE];
