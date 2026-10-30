// Pure helpers shared by the edit-ui page and tests. The textarea is an override:
// non-empty free text replaces the loaded style-lock object; an empty textarea
// sends the object; neither present sends ''.

export function resolveStyleLock({ freeText = '', loaded = null } = {}) {
  const text = typeof freeText === 'string' ? freeText.trim() : '';
  if (text) return text;
  if (loaded == null) return '';
  return loaded;
}

export function matchSavedElement(elements, saved) {
  if (!saved || typeof saved !== 'object') return null;
  if (typeof saved.type !== 'string' || typeof saved.name !== 'string') return null;
  return (elements || []).find((el) => el.type === saved.type && el.name === saved.name) || null;
}

// A list request that did not succeed must not be treated as "this element is gone".
export function elementSelectionAfterList(saved, elements, { listed }) {
  if (!listed) return saved && typeof saved === 'object' ? saved : null;
  return matchSavedElement(elements, saved);
}

export function elementOptionValue(el) {
  return `${el.type}/${el.name}`;
}
