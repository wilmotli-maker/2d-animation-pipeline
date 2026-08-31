function reOrNull(s) { return s ? new RegExp(s) : null; }
function anyOf(list, set) { return !set || !set.length || list.some((x) => set.includes(x)); }

export function applyShotFilters(model, { match, characters, episodes } = {}) {
  const re = reOrNull(match);
  const shots = model.shots.filter((s) =>
    (!re || re.test(s.shotId)) &&
    (!characters || !characters.length || anyOf(s.characters, characters)) &&
    (!episodes || !episodes.length || (s.episode != null && episodes.includes(s.episode))));
  return { ...model, shots };
}

export function applyImageFilters(model, { match, characters, sheets } = {}) {
  const re = reOrNull(match);
  const nameSet = characters && characters.length ? characters : null;
  const out = [];
  for (const c of model.characters) {
    if (nameSet && !nameSet.includes(c.name)) continue;
    const keptSheets = c.sheets.filter((s) =>
      (!sheets || !sheets.length || sheets.includes(s.sheetType)) &&
      (!re || re.test(s.slug)));
    if (keptSheets.length) out.push({ ...c, sheets: keptSheets });
  }
  return { ...model, characters: out };
}
