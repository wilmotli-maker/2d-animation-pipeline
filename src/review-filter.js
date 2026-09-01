function reOrNull(s) { return s ? new RegExp(s) : null; }
function anyOf(list, set) { return !set || !set.length || list.some((x) => set.includes(x)); }

export function applyShotFilters(model, { match, exclude, characters, episodes } = {}) {
  const re = reOrNull(match);
  const ex = reOrNull(exclude);
  const shots = model.shots.filter((s) =>
    (!re || re.test(s.shotId)) &&
    (!ex || !ex.test(s.shotId)) &&
    (!characters || !characters.length || anyOf(s.characters, characters)) &&
    (!episodes || !episodes.length || (s.episode != null && episodes.includes(s.episode))));
  return { ...model, shots };
}

export function applyImageFilters(model, { match, exclude, characters, sheets } = {}) {
  const re = reOrNull(match);
  const ex = reOrNull(exclude);
  const nameSet = characters && characters.length ? characters : null;
  const out = [];
  for (const c of model.characters) {
    if (nameSet && !nameSet.includes(c.name)) continue;
    const keptSheets = c.sheets.filter((s) =>
      (!sheets || !sheets.length || sheets.includes(s.sheetType)) &&
      (!re || re.test(s.slug)) &&
      (!ex || !ex.test(s.slug)));
    if (keptSheets.length) out.push({ ...c, sheets: keptSheets });
  }
  return { ...model, characters: out };
}

// Default selection shows ALL versions side by side; the reviewer hides any they
// don't want from the page. (Was previously the 2 most recent.)
export function defaultShotSelection(model, layout = 'side-by-side') {
  const versions = {};
  for (const s of model.shots) versions[s.shotId] = s.versions.map((v) => v.version);
  return { layout, versions };
}

export function defaultImageSelection(model, layout = 'side-by-side') {
  const versions = {};
  for (const c of model.characters) {
    for (const sh of c.sheets) {
      versions[`${c.name}/${sh.sheetType}/${sh.slug}`] = sh.versions.map((v) => v.version);
    }
  }
  return { layout, versions };
}
