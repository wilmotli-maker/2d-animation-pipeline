# style-lock.yaml field reference

`style-lock.yaml` is the durable, per-element spec re-injected into the director
skills on every generation so style doesn't drift across a batch or across
separate chat sessions. It is a free-form YAML map; the fields below are the
conventional keys the director skills read. Two variants:

## Illustrated (illustration-director / illustration-worldbuilder)

```yaml
styleRegister: flat-cartoon        # e.g. flat-cartoon, anime, comic, children's-book
palette:                           # locked hex swatches
  - "#1b1b1b"
  - "#ff5a5f"
lineWeight: 2                      # relative stroke weight
proportions: chibi                 # e.g. chibi, realistic, elongated
wardrobe: "red hoodie, denim shorts"
notes: "no gradients; hard cel shading only"
```

## Photoreal (banana-pro-director / cinema-worldbuilder)

```yaml
skin: "visible pores, subsurface scattering"
hair: "strand-by-strand, warm brown"
fabric: "cotton weave, natural drape"
wardrobe: "charcoal wool coat"
grade: "Kodak Vision3, low contrast"
notes: "hyperreal stack locked"
```

Add or drop keys freely — the pipeline persists whatever object it's given.

`style-lock.yaml` is **user data**, not pipeline tooling — created and customized
per project (and often per element) by whoever runs the pipeline. It lives under
`elements/…` with the other generated artifacts, which this infrastructure repo
gitignores. Whether and how you version your own project data is your choice, not
something this tool prescribes.
