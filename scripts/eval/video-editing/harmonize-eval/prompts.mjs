// Shared prompt constants for the two-stage previz→restyle harmonization, used by
// both harmonize.js (single-clip) and experiment.js (batch). Kept in sync with the
// `previz-blocking` Claude-template skill (templates/skills/previz-blocking/SKILL.md).

// Stage 1: collapse the source's (mismatched) rendering to a neutral greybox blocking
// pass that carries ONLY motion/timing on an empty grey void, full-body framing kept.
export const PREVIS_PROMPT =
  'VISUAL OVERRIDE — HIGHEST PRIORITY: completely discard all line art, colour, ' +
  'shading, texture and character design from the reference video. The source drawing ' +
  'is NOT the visual target. Use it only to recover body motion, performance timing, ' +
  'pose and gesture. Render the result as an ANIMATION BLOCKING PASS in placeholder ' +
  'geometry: the character must become an obvious articulated animation mannequin — ' +
  'sphere-like head, single-piece torso, simple pelvis, capsule arms, capsule legs, ' +
  'block-like hands and feet — a rig-testing dummy, not a finished character. Do not ' +
  'recreate clothing, face or costume; represent them only as slightly enlarged ' +
  'primitive body volumes for silhouette. BACKGROUND: a completely empty, featureless, ' +
  'flat matte grey void — absolutely no environment, set, floor, walls, boxes, planes, ' +
  'cylinders, steps, props or scenery of any kind; nothing but the single mannequin on ' +
  'seamless grey. FRAMING: keep the source\'s exact camera framing and character scale ' +
  '— the whole mannequin stays in frame from the top of the head to the feet, in the ' +
  'same position and with the same margins as the source; never crop, zoom, pan or ' +
  'reframe. The first impression of every frame must be "unfinished 3D animation previs." ' +
  'It must never be mistaken for finished 2D artwork.';

// Stage 2: repaint the neutral previz in the reference image(s)' style. Because the
// input is uniform, the styling lands consistently across the whole clip.
export const STYLE_PROMPT =
  'Repaint this grey placeholder previs animation as a finished, hand-drawn 2D ' +
  'illustrated character in the EXACT style of the reference image(s) — their character ' +
  'design, colour palette, line weight, shading and texture. Keep the body motion, pose, ' +
  'gesture and timing from the video completely unchanged. Apply the reference look ' +
  'identically on every frame so the whole clip reads as one continuous, uniformly-styled ' +
  'shot. FRAMING: preserve the exact framing, character scale and composition of the ' +
  'video — the entire character stays in frame from the top of the head to the feet with ' +
  'the same margins; never crop below the feet, knees or waist, never zoom in, never ' +
  'reframe. Keep the background the same plain flat colour as the reference image; add no ' +
  'scenery, props or set.';
