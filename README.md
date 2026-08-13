# web/ — static viewers

Self-contained HTML pages for reviewing pipeline output by eye. Each page lives in
its own folder with an `index.html` and whatever small media it needs. Nothing here
is built or bundled — open the file and it works.

## Pages

<!-- pages:start -->
| Page | What it shows |
| --- | --- |
| [matte-best-vs-fast](matte-best-vs-fast/index.html) | Alpha-matte evaluation, `quality=best` (BiRefNet-DIS) vs `quality=fast` (isnet-general-use), across all 13 Art + AI_ALT2 shots / 2,173 frames. Per-shot timing and structural metrics, plus side-by-side comparison clips for the edge-quality judgement the numbers can't make. |
<!-- pages:end -->

## Viewing

Open the `index.html` directly, or serve the folder if your browser blocks local
video playback:

```bash
python3 -m http.server -d web 8000
```

Then visit `http://localhost:8000/matte-best-vs-fast/`.

## Adding a page

1. Create `web/<page-name>/index.html`, self-contained (inline CSS/JS, no CDN).
2. Keep media small and next to the page — these clips are versioned in git.
   Multi-hundred-MB source renders belong in `evaluation/`, which is gitignored.
3. Regenerate the table above:

   ```bash
   npm run web:index
   ```

   The table between the `pages:start` / `pages:end` markers is generated from
   the folders in `web/`. Descriptions are hand-written and preserved across
   runs — a new page gets a placeholder seeded from its title, marked `TODO`,
   for you to replace with real prose. `npm run web:index:check` fails if the
   table is stale, so it works as a pre-commit or CI check.
