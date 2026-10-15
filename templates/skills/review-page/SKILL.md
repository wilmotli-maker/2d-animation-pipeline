---
name: review-page
description: Build a review or comparison page for this animation project's shots or images. Use whenever the user asks for a review page, a comparison page, a side-by-side, or wants to look at / compare shots, clips, versions, or image sheets — including ad-hoc A/B/C comparisons of variants. ALWAYS use the pipeline's `pipeline review` command; never hand-write an HTML page.
---

# Review Page

Build review and comparison pages with the pipeline's built-in `pipeline review` command. **Never
hand-roll an HTML page** — the review command produces the project's standard page (client-side
filtering, side-by-side version comparison, self-contained assets) that everyone here already uses.
A custom one-off page is off-pattern and loses that shared UI.

## Commands

**Shots** (video clips):

```
pipeline review shots --slug <name> [--match <re>] [--exclude <re>] [--characters a,b] \
  [--episode N,M] [--layout side-by-side|stacked] [--update] [--out <dir>]
```

Builds from the `shots/` tree. Filters combine (intersection); `--exclude` drops ids/slugs matching
a regex. Default output is `<root>/web/<slug>/`; `--out <dir>` picks another folder.

**Images** (element sheets):

```
pipeline review images --slug <name> [--match <re>] [--exclude <re>] [--characters a,b] \
  [--sheets turnaround,pose,cycles] [--update] [--out <dir>]
```

## Ad-hoc comparisons (variants, A/B/C, re-rendered takes)

For clips that are NOT in the `shots/` tree — e.g. comparing several renders, settings, or engine
variants of the same clip — put them in one flat folder and use `--folder`:

```
pipeline review shots --slug <name> --folder <dir> --out web/<name>
```

Filenames in that folder encode shot + version as **`<shotId>-vNNN.ext`**. Each distinct `<shotId>`
becomes one shot; the `vNNN` values become its versions, which the page shows **side by side**. So to
compare variants of each example, name them with a shared shotId and one version per variant:

```
<example>-v01.mp4   <example>-v02.mp4   <example>-v03.mp4
```

Then tell the user which version number maps to which variant (the page labels them v01/v02/v03). A
file with no `-vNNN` suffix is treated as a single v001 shot. Only video files are picked up.

## Rules

- Reach for `pipeline review` for ANY review/comparison page request. If the clips aren't under
  `shots/`, stage them in a flat folder and use `--folder` — do not build a page by hand.
- If a page already exists, pass `--update` to refresh it in place.
- After building, give the user the output path (and open it if appropriate).
