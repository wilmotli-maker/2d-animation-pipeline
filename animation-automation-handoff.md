# Animation Automation Pipeline — Handoff for Claude Code

## Goal
Build an automated pipeline where Claude directs prompt generation for image/video
models (via existing custom skills: illustration-director, banana-pro-director,
cinema-worldbuilder, illustration-worldbuilder), and generation calls are executed
programmatically against Higgsfield rather than manually through their UI.

## Key findings from research (this session)

**No direct API access.** Higgsfield Ultra subscription does not include API/key-based
access to their Cloud API. Confirmed by checking the account directly — do not assume
otherwise.

**Two agent-integration paths exist, chosen: CLI over MCP.**

- MCP (`https://mcp.higgsfield.ai/mcp`) ties generation to a live, chat-mediated Claude
  session (web/Cowork/Claude Code) — every generation call requires an LLM turn to
  decide to invoke the tool. Not suitable for headless/batch automation or a
  multi-tenant product backend (auth is per-account session, not a server-side key).
- **CLI (`@higgsfield/cli`, official repo `higgsfield-ai/cli` on GitHub)** — a real,
  scriptable binary. This is the chosen path for automation.
  - Install: `curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh`
    (or `npm install -g @higgsfield/cli`, or `brew install higgsfield`)
  - Auth: `higgsfield auth login` (browser-based, session persists — needs verification, see sanity checks)
  - Core command shape:
    ```bash
    higgsfield generate create <model> --prompt "..." [model-specific flags] --wait
    higgsfield generate get <job_id>
    higgsfield generate wait <job_id>
    higgsfield generate workflow <workflow_name> [flags] --wait
    higgsfield model list
    higgsfield model get <job_set_type>   # live required-flag schema per model
    ```
  - Media inputs (`--image`, `--start-image`, `--end-image`, `--video`, `--audio`,
    `--sketch`) accept a local file path (auto-uploaded) or a UUID from a prior job.
  - Billing: draws from the same Higgsfield credit pool as the Ultra plan (needs
    dollar-for-dollar verification, see sanity checks).
  - There's also an official `higgsfield-ai/skills` repo: Markdown-based agent skills
    for Claude Code/Cursor/Codex, separate from the user's own custom skills — worth
    installing alongside, not instead of, the existing director skills.

**⚠️ Unofficial/risky forks to avoid:** `clawdybotty/higgsfield-cli` and
`donghaozhang/higgsfield-cli` are third-party, unaffiliated tools. One explicitly
reverse-engineers Higgsfield's private API and bypasses Cloudflare protections —
real risk of ToS violation / account ban. Use only `higgsfield-ai/cli`.

## Target architecture (CLI-based)

```
Director skill (illustration-director / banana-pro-director / cinema-worldbuilder /
illustration-worldbuilder)
        ↓ produces structured prompt + locked style spec (per-project/character)
Script / Claude Code orchestration layer
        ↓ invokes `higgsfield generate create ... --wait` (or async + `generate wait`)
Higgsfield CLI → Higgsfield backend
        ↓ returns job result (media URL / local file)
Claude Code review step (optional)
        ↓ compares output against locked style spec, decides regenerate or accept
```

Key shift from the MCP model: generation itself becomes a plain CLI subprocess call
(scriptable, batchable, file-in/file-out), and Claude/Claude Code is only invoked at
decision points (style critique, regeneration, batch orchestration) — not on every
single generation call.

Style-lock data (line weight, palette, wardrobe, proportions for illustrated; skin/
hair/fabric texture specs for photoreal) should persist per-project/character outside
the LLM context — e.g. a JSON/YAML file per character — and get re-injected into the
director skill's system prompt on every subsequent generation call so style doesn't
drift across a long batch run.

## Element & shot data model

Two first-class entities, both persisted on disk (not just in LLM context) so they can
be re-ingested as context for later generations:

**Elements** — a character, prop, scene, or other persistent story asset. Created from
some combination of prompt, reference image(s), reference video(s), and speech sample.
Produces durable artifacts (turnaround sheets, pose sheets, animation cycles) that later
shots draw on.

**Shots** — a 2-10s clip built from one or more elements. Goes through multiple
low-resolution refinement iterations (cheap, fast, credit-conscious) before a single
final upscale to production resolution once the shot is locked.

Proposed directory structure:

```
elements/
  <type>/<element-name>/              # type: characters | props | scenes | other
    inputs/
      prompt.md                       # base creation prompt / description
      reference-images/
      reference-videos/
      speech-samples/
    style-lock.yaml                   # versioned locked spec: palette, line weight,
                                       # wardrobe, proportions (illustrated) or skin/
                                       # hair/fabric texture spec (photoreal)
    sheets/
      turnaround/                     # v001, v002, ... per regeneration
      pose/
      cycles/                         # walk cycle, idle loop, etc.
    generations.jsonl                 # append-only log: prompt used, model, job id,
                                       # output path, timestamp, accepted/rejected

shots/
  <shot-id>/                          # e.g. s010_kitchen-intro
    shot.yaml                         # elements used + style-lock version pins,
                                       # duration, camera/scene description, mode
    drafts/
      v001/
        prompt.md
        output.<ext>                  # low-res iteration output
        notes.md                      # critique / regen decision log
      v002/ ...
    final/
      output.<ext>                    # upscaled production-resolution result
      source-draft.txt                # which draft version was promoted

style-lock-schema.md                  # shared field reference for style-lock.yaml
                                       # (photoreal vs illustrated variants)
```

This gives the director skills (illustration-director, banana-pro-director,
cinema-worldbuilder, illustration-worldbuilder) a consistent place to read prior style
state from and write new artifacts to, independent of any single chat session —
`generations.jsonl` and `style-lock.yaml` are the mechanism that prevents style drift
across a long batch run or across separate conversations.

## Authentication plan (shared codebase, local execution)

**Distribution model (decided):** this pipeline is shared as a **codebase**, not a
hosted service. Each collaborator clones the repo and runs everything on their own
machine, under their own accounts. No credentials are ever stored, proxied, or
transmitted through any shared server or repo — this sidesteps the entire class of
multi-tenant secret-storage problems a hosted version would require.

**Higgsfield**
- Each user needs their own Higgsfield subscription (Ultra or whatever tier supports
  the CLI). Credits draw from *their* account only — no shared billing pool.
- The CLI is installed **per-workspace via `package.json`** (`@higgsfield/cli`,
  currently `1.1.19`), not globally with `npm install -g` or the curl installer —
  each collaborator runs `npm install` in their own clone, so the dependency lives in
  their local `node_modules/` and never touches the global npm install. `scripts/`
  auto-detect the local `node_modules/.bin` binary.
- Auth is `higgsfield auth login` (or `npm run higgsfield -- auth login` in this
  workspace) — the CLI's existing browser-based OAuth flow, which persists a session
  locally (exact storage location TBD — see sanity check 1 below). Nothing new to
  build here beyond documenting it and validating it up front.
- **Login alone is not enough: a billing-workspace context is also required.**
  `higgsfield generate create ...` exits non-zero (code 4) with "No workspace selected"
  and hints `workspace set <workspace_id>`. This context **determines whose credits are
  billed**, so in the shared-codebase model each collaborator establishes their own
  after logging in — a second, mandatory half of per-user setup. Discovered running
  sanity check 2.
  - ✅ **RESOLVED (sanity check 2):** `generate` requires `workspace set` to have been
    run **explicitly at least once** — even for the single default "Private" workspace.
    After `higgsfield workspace set <id>`, the exit-code test's valid call exited 0.
    The private-only account works fine; **no named/team workspace is required** — good
    news for the sharing plan (each collaborator just runs `workspace set` once).
  - **Why the flag lies:** `workspace set` persists the selection to the local
    `~/.config/higgsfield/config.json` (which `generate` reads), and this is separate
    from the server-side `is_selected: true` that `workspace status` reports. Status is
    byte-for-byte identical before and after `set`, so there is **no readiness signal in
    `workspace status`** — a status-based preflight gate is impossible.
  - **Consequence for tooling:** `check-auth.sh` reports workspace context
    **informationally** (correct — it can't reliably gate), so `workspace set` must be a
    documented, mandatory step in setup (`SETUP.md`, still to write). A gate could parse
    `config.json`, but that's an undocumented CLI-internal format — fragile; not worth it.

**Claude / Claude Code**
- Two sub-cases depending on how the orchestration layer ends up invoking Claude
  (this is still open pending the sanity checks and orchestration design below):
  - **Interactive** (skills invoked through Claude Code chat): user just needs their
    own Claude Code login/subscription. Nothing extra to build.
  - **Headless** (a standalone script calls the Anthropic API directly for the
    style-critique/regeneration-decision step): each user supplies their own
    `ANTHROPIC_API_KEY`.
- Standardize on a `.env` file at repo root (gitignored) loaded via a standard dotenv
  pattern, with a `.env.example` committed containing placeholder keys only. Document
  explicitly: never commit `.env`, never paste real keys into shared docs or issues.
- Add `.env` (and any local Higgsfield session/config files that might land inside the
  repo directory) to `.gitignore`.

**Setup & validation**
- `scripts/check-auth.sh` — **built.** Confirms the Higgsfield CLI is installed,
  authenticated (via a free `higgsfield model list` call), **reports the billing
  workspace context** (informational, per the readiness caveat above), and confirms
  Claude access (`ANTHROPIC_API_KEY` or a logged-in `claude` CLI). Fails fast with a
  specific message per missing piece rather than failing mid-batch. Verified it
  degrades cleanly when the CLI isn't installed yet.
- `SETUP.md` walking a new collaborator through install → login → **workspace set** →
  preflight check — still to write once `.env`/`.env.example` conventions are finalized.
- This extends sanity check 1 (auth persistence) below: its deliverable should be the
  preflight script itself, not just a manual finding.

**If the distribution model ever changes** (e.g. moving to a hosted service others use
without installing anything), this entire section needs to be redesigned — per-user
encrypted token storage, a secrets manager, and multi-tenant job isolation would all be
required. That is explicitly out of scope for the current design.

## Sanity checks to run before building on this (in progress)

Runnable scripts for all 7 checks exist in `scripts/` — see
`scripts/sanity-checks/README.md` for cost per script and run order. The CLI is
installed (`@higgsfield/cli` local to the workspace) and execution is underway;
status per check is noted inline below.

1. **Auth persistence** — login once, reopen terminal later, confirm no re-prompt.
   README notes tokens are short-lived; find the actual expiry/refresh behavior.
   Script: `scripts/check-auth.sh` (free). ✅ Auth works this session; still worth
   re-running in a separate sitting to exercise the "reopen terminal" condition.
2. ✅ **Non-interactive exit codes — PASSED.** Broken call (bogus model) exits
   non-zero (`4`); valid call exits `0` — reliable for scripting/retry logic. Note:
   this only holds once a workspace is set (see the workspace resolution above);
   before that, *both* calls exit `4` with "No workspace selected".
   Script: `scripts/sanity-checks/02-exit-codes.sh` (~1 credit).
3. **Model schema drift** — run `higgsfield model get <model>` for the 2-3 models
   actually planned for use; diff against MODELS.md examples in the repo (README
   says the live command is authoritative, not the docs file).
   Script: `scripts/sanity-checks/03-model-schema.sh` (free).
4. **Credit accounting** — one cheap generation, check Ultra account credit balance
   before/after, confirm CLI draws from the same pool at the expected rate.
   Script: `scripts/sanity-checks/04-credit-accounting.sh` (~1 credit). Note: a
   balance IS available via `higgsfield workspace status` (`credits` field) — update
   the script to use it instead of the manual dashboard fallback. ⚠️ Heads-up: after
   check 2's successful generation the `credits` field still read 2755 (unchanged) —
   verify whether the balance is cached/eventually-consistent or the test model was
   free, since that affects how reliably per-run credit usage can be logged.
5. **File I/O round-trip** — generate with `--start-image` pointing to a local file;
   confirm correct upload (not treated as a bad UUID) and confirm output is
   retrievable via `generate get <job_id>` after process exit.
   Script: `scripts/sanity-checks/05-file-io-roundtrip.sh` (~1 credit; needs a test
   image at `scripts/sanity-checks/fixtures/test-image.png`).
6. **Resumability of long jobs** — start a video job without `--wait`, close the
   terminal, run `higgsfield generate wait <job_id>` later from a fresh shell.
   Confirms jobs are server-side/resumable — important for unattended batch scripts.
   Scripts: `scripts/sanity-checks/06a-start-long-job.sh` then, from a new terminal,
   `06b-resume-long-job.sh` (~1 credit).
7. **Concurrency** — fire two `generate create` calls back to back without waiting,
   poll both — confirms whether parallel jobs are allowed or serialized, which
   determines batch throughput design.
   Script: `scripts/sanity-checks/07-concurrency.sh` (~2 credits).

Items 1, 3, and 6 are the most likely to break an unattended batch script if they
don't behave as documented — prioritize these. Before running any credit-spending
script, edit `scripts/sanity-checks/config.sh` with real model ids (get them for
free from checks 1 and 3 first).

## What Claude Code should do next
1. Scaffold the `elements/` and `shots/` directory structure above (including
   `style-lock-schema.md`) and add `.env.example` + `.gitignore` entries per the
   authentication plan.
2. Build `scripts/check-auth.sh` (or equivalent) and `SETUP.md` per the authentication
   plan, and use it to actually run sanity check 1.
3. Run the remaining sanity checks and report actual behavior vs. assumptions.
4. Based on results, design the orchestration script (language/runtime TBD) that:
   - reads a scene/character queue,
   - loads the relevant director-skill output (existing custom skills),
   - reads/writes `style-lock.yaml` and `generations.jsonl` per element,
   - invokes the CLI per item,
   - handles polling/retries for video jobs,
   - logs credit usage per run.
5. Once the sanity checks and orchestration design are settled, write a proper
   bite-sized implementation plan (per the writing-plans skill format) for the
   orchestration script itself — this handoff doc is the architecture/design layer,
   not yet an execution plan.

## Relevant existing context
- User maintains two separate pipelines: **photoreal** (banana-pro-director,
  cinema-worldbuilder skills) and **illustrated** (illustration-director,
  illustration-worldbuilder skills), both built on Higgsfield/Seedance.
- Recurring illustrated character: Cecilia (flat cartoon style).
- User is also evaluating cost-efficiency of Higgsfield Ultra against alternatives
  (fal.ai pay-as-you-go Seedance 2.0, Dreamina, direct Gemini image access) — worth
  keeping in mind since a CLI-automated pipeline changes the usage/cost profile
  versus manual generation.
