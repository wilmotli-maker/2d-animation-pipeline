// src/edit-ui/generators.js
// Registry of edit-ui generation backends. A generator is `{ name, run(job) }`
// (see generator.js for the run() contract). Selecting a backend by name keeps
// bin/pipeline.js and the server out of the business of knowing which backends
// exist: adding a real backend (MuAPI Seedance, Aleph) is a one-line entry here
// plus a run() that consumes readRunView() from runview.js.
import { createStubGenerator } from './generator.js';
import { createTrimGenerator } from './trim-generator.js';
import { hfBackend, muapiBackend, falBackend } from './backends.js';

// name -> factory(). Factories are lazy so a backend that needs credentials or a
// heavy import isn't constructed until it's the one actually selected. The real
// backends share the trim generator; only the submission differs (see backends.js).
//   fal   — direct fal.ai Seedance 2.5, no moderation, cheapest at 480p (needs FAL_KEY)
//   muapi (default) — MuAPI Seedance 2.5, no moderation (needs MUAPI_KEY + FAL_KEY)
//   hf    — Higgsfield Seedance (unreliable: full-quality lip-sync nsfw-blocks)
const REGISTRY = {
  muapi: () => createTrimGenerator({ backend: muapiBackend() }),
  fal: () => createTrimGenerator({ backend: falBackend() }),
  hf: () => createTrimGenerator({ backend: hfBackend() }),
  'seedance-draft': () => createTrimGenerator({ backend: hfBackend() }), // back-compat alias for hf
  stub: createStubGenerator,
};

export const DEFAULT_GENERATOR = 'muapi';

export function generatorNames() {
  return Object.keys(REGISTRY);
}

// Build the named generator, or the default when name is falsy. Throws a message
// listing the valid names for an unknown one.
export function resolveGenerator(name = DEFAULT_GENERATOR) {
  const key = name || DEFAULT_GENERATOR;
  const factory = REGISTRY[key];
  if (!factory) {
    throw new Error(`unknown generator "${key}" — valid: ${generatorNames().join(', ')}`);
  }
  return factory();
}
