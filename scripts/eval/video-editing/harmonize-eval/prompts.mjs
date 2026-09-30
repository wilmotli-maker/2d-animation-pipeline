// Shared prompt constants for the two-stage previz→restyle harmonization, used by
// both harmonize.js (single-clip) and experiment.js (batch). Kept in sync with the
// `previz-blocking` Claude-template skill (templates/skills/previz-blocking/SKILL.md).

// Stage 1: collapse the source's (mismatched) rendering to a neutral greybox blocking
// pass that carries ONLY motion/timing on an empty grey void, full-body framing kept.
export const PREVIS_PROMPT =
  'Re-render the exact character in this video as a single-colour, untextured grey CLAY ' +
  'MAQUETTE — a 3D greybox / blocking-model version of THIS specific character. ' +
  'SHAPE — keep the character\'s exact silhouette, proportions and body-part shapes from ' +
  'the source: the same head shape and size, the same body, torso, limbs, hands and feet, ' +
  'and every distinctive feature it has (antennae, snout, muzzle, tail, ears, horns, ' +
  'spikes, fins, wings, extra or non-human limbs, block feet, etc.). Do NOT replace it ' +
  'with a generic humanoid figure, a human body, a rounded human head, or a wooden ' +
  'artist\'s posing mannequin, and do NOT change, regularise or humanise any proportion — ' +
  'a boxy head stays boxy, an animal body stays an animal body, a robot stays that robot\'s ' +
  'shape. FACE & EXPRESSION — KEEP the character\'s facial features and current expression ' +
  'on every frame: eyes, eyebrows, the mouth (or beak / muzzle), nose, and any visible ' +
  'teeth or tongue must stay, sculpted into the grey clay as raised or recessed relief so ' +
  'the expression reads clearly — never leave a blank, smooth or featureless face, and do ' +
  'not drop the mouth. MATERIAL — strip ALL colour and texture: remove every colour, line, ' +
  'outline, marking, pattern, logo, printed text and surface texture that came from the ' +
  'source. The ENTIRE character — body, head, face, hair, fur, skin, eyes, clothing and ' +
  'every accessory — must become ONE uniform flat matte light neutral-grey (like untextured ' +
  '3D greybox or pale grey modelling clay), shown only through soft smooth shading. ' +
  'Absolutely no colour survives anywhere: no coloured hair or fur, no coloured eyes, no ' +
  'coloured glasses lenses or frames, no wood tone, no tints or textures from the source — ' +
  'every part is the same grey. BACKGROUND: a completely empty, ' +
  'featureless flat matte grey void — no environment, floor, set, walls, props or scenery ' +
  'of any kind; nothing but the single grey character on seamless grey. FRAMING: keep the ' +
  'source\'s exact camera framing and character scale — the whole character stays in frame ' +
  'from top to bottom in the same position and with the same margins as the source; never ' +
  'crop, zoom, pan or reframe. Preserve the body motion, performance timing, pose and ' +
  'gesture exactly. The result must read as an untextured grey 3D previz model of this ' +
  'character — never finished or coloured 2D artwork, and never a generic dummy.';

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
