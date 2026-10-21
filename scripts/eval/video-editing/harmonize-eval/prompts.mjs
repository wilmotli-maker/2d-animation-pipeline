// Prompt constants for the two-stage previz→restyle harmonization, used by
// harmonize.js (single-clip) and experiment.js (batch).
//
// These now live in src/harmonize.js — the single source of truth, also used by the
// `pipeline video harmonize` command. This module re-exports them so the spike and the
// shipped pipeline can never drift. The `previz-blocking` Claude-template skill keeps a
// verbatim copy of the previz prompt for its own documentation.
export { PREVIS_PROMPT, STYLE_PROMPT } from '../../../../src/harmonize.js';
