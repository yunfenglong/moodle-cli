# Setup and Authentication

Read this file for installation, first-run configuration, browser-session reuse, or authentication recovery.

## Install

Prefer the published npm package:

```bash
npm install -g moodle-cli
moodle --version
```

Use `npx moodle-cli --help` for a one-off run. Existing PyPI users should migrate with:

```bash
uv tool uninstall moodle-cli
npm install -g moodle-cli
```

Standalone binaries are available from GitHub Releases for supported platforms.

## Configure the Moodle Site

Set `MOODLE_BASE_URL` to the Moodle site root, such as `https://school.example.edu`. A URL ending in `/login/index.php`, `/my/`, or another page is invalid.

For an interactive first run, allow the CLI to prompt for the root URL and save it under `~/.config/moodle-cli/config.yaml`.

## Authenticate

The CLI tries these session sources:

1. `MOODLE_SESSION`
2. A fresh local session cache
3. Supported browser cookies
4. `okta-auth-cli`

For automatic Okta login:

```bash
uv tool install okta-auth-cli
okta config
```

Validate setup with:

```bash
moodle user --json
```

Setup is complete when this returns the authenticated Moodle user.

## Recover Failures

- **No usable MoodleSession**: sign in to Moodle in a supported browser and retry; otherwise configure `okta-auth-cli` or provide `MOODLE_SESSION` through the environment.
- **Configured site is wrong**: correct `MOODLE_BASE_URL` or the saved `base_url`, then rerun `moodle user --json`.
- **Cached session expired**: rerun with `--no-cache` once so the CLI reacquires a session.
- **Non-interactive config error**: set `MOODLE_BASE_URL`; a pipe cannot answer the first-run prompt.
