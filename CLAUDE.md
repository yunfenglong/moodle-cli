# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Flags

```yaml
agent_flags:
  token_economy: prioritize
  response_style: terse
  planning_style: minimal
```

Interpret these as defaults:

- Prefer the shortest sufficient response.
- Avoid long preambles and repeated summaries.
- Ask questions only when a wrong assumption is likely to be costly.
- Make the smallest maintainable change that solves the task.

## Build & Run

```bash
npm ci                  # install dependencies
npm run check           # typecheck (tsc --noEmit)
npm test                # vitest run
npm run build           # typecheck + tsup bundle → dist/moodle.js
node dist/moodle.js     # run built CLI
```

TypeScript (ESM, Node >= 20), bundled by tsup into a single `dist/moodle.js` (the `moodle` bin). No linter/formatter is configured. CI (`.github/workflows/ci.yml`) runs typecheck, tests, build, npm-pack content/smoke checks, and a skill-bundle drift check on Node 20/22 and Bun.

## Architecture

Terminal CLI for Moodle LMS that piggybacks on the user's browser session — no API tokens needed.

### API Strategy

Uses Moodle's **internal AJAX endpoint** (`/lib/ajax/service.php`), not the official Web Services token API. This endpoint accepts the `MoodleSession` browser cookie, same as the Moodle web UI. The client first loads an authenticated page to resolve `sesskey`, then tries AJAX APIs and falls back to page scraping when site-specific Moodle restrictions disable some services.

Request format: `POST /lib/ajax/service.php?sesskey={sesskey}&info={function_name}` with JSON body `[{"index": 0, "methodname": "...", "args": {...}}]`. Response: `[{"error": false, "data": ...}]`.

### Data Flow

```
auth.ts (get cookie) → client.ts (AJAX calls, scraping fallback) → parsers.ts / scraper.ts (→ models) → formatters.ts / output.ts (display)
        ↑                     ↑
   env var, browser      sesskey + userid auto-resolved;
   cookies, or cached    session cached in ~/.cache/moodle-cli/session.json
   session
```

- **cli.ts**: Commander program. `buildProgram(io)` takes injectable IO (stdout/stderr/fetch/env/homeDir) so tests can drive the full CLI. `runCli()` maps errors (`CliError` hierarchy in errors.ts) to exit codes and JSON error output. A bare URL argument dispatches to the matching command via url-resolver.ts.
- **auth.ts**: Cookie priority: `MOODLE_SESSION` env var → cached session → browser cookie extraction. Sessions persist via **session-cache.ts** (24h TTL, `--no-cache` bypasses reads).
- **client.ts**: `MoodleClient` — batched AJAX calls (`callBatch`), auto re-auth on session expiry, per-method fallbacks to **scraper.ts** (HTML scraping with node-html-parser) when AJAX functions are disabled server-side.
- **models.ts**: Plain interfaces with snake_case serialization fields.
- **parsers.ts**: Pure functions transforming Moodle JSON dicts → model instances. **scraper.ts** does the same from HTML.
- **formatters.ts**: Human-readable table/tree output. **output.ts**: `--json`/`--yaml`/`--fields` structured output (default is JSON when stdout is not a TTY).
- **config.ts**: Loads `config.yaml` from CWD or `~/.config/moodle-cli/`. If no `base_url` is configured, it prompts, validates, probes the site, and saves. `MOODLE_BASE_URL` env var overrides.
- **download.ts / export.ts**: authenticated file downloads (`download` command; resource/folder/assign-submission plans) and whole-course offline export (`export`). **course-search.ts**: client-side search over course contents (`search`). **ics.ts**: local ICS generation for `calendar --ics`.
- **Write operations** go through the web-form route (cookie + sesskey + hidden-field replay via `parseFormWithField`), not AJAX, because sites disable most mod_* WS functions: **assign-submit.ts** (`submit` — draft upload via /repository/repository_ajax.php then savesubmission; `--submit --confirm` for the confirmsubmit lock step), **choice.ts** (`choice --answer`), **feedback.ts** (`feedback --answer`, multi-page). Completion ticks (`complete`) and `alerts --mark-read` use ajax-enabled core functions directly.
- **keepalive.ts**: `auth keepalive` commands + macOS launch agent that renews the session periodically.
- **skills.ts**: Generates the agent skill bundle (`SKILL.md`, `references/`, `agents/openai.yaml`) from the Commander command tree. Regenerate with `npm run skill:generate` after touching commands; CI fails on drift.
- **constants.ts**: API paths, AJAX function names, env var names.

### Adding a New Command

1. Add the Moodle AJAX function name / view path to `constants.ts`
2. Add a method to `MoodleClient` in `client.ts` (scraping fallback in `scraper.ts` if the AJAX function may be disabled)
3. Add a model interface to `models.ts`, parser to `parsers.ts`
4. Add a display function to `formatters.ts`
5. Register the command in `cli.ts` via `addOutputOptions(program.command(...))`
6. Add a vitest test in `tests/` (mock `fetchImpl` through `buildProgram`/`createMoodleClient` IO injection)
7. Rebuild (`npm run build`) and run `npm run skill:generate`; commit the regenerated `SKILL.md`/`references/`/`agents/openai.yaml`
