// src/edit-ui/generators.js
// Registry of edit-ui generation backends. A generator is `{ name, run(job) }`
// (see generator.js for the run() contract). Selecting a backend by name keeps
// bin/pipeline.js and the server out of the business of knowing which backends
// exist: adding a real backend (MuAPI Seedance, Aleph) is a one-line entry here
// plus a run() that consumes readRunView() from runview.js.
import { createStubGenerator } from './generator.js';
import { createTrimGenerator } from './trim-generator.js';

// name -> factory(). Factories are lazy so a backend that needs credentials or a
// heavy import isn't constructed until it's the one actually selected.
const REGISTRY = {
  'seedance-draft': createTrimGenerator,
  stub: createStubGenerator,
};

export const DEFAULT_GENERATOR = 'seedance-draft';

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
