# Maintenance

Read this file for update checks, upgrades, agent-skill installation, or repository skill regeneration.

## Update the CLI

Check without changing the installation:

```bash
moodle update --check-only --json
```

Run `moodle update --table` when the user explicitly wants the installation upgraded. npm installations use `npm install -g moodle-cli@latest`; standalone binaries return the latest GitHub Release URL.

If the registry check fails, verify network access and retry before proposing an upgrade command.

## Install the Agent Skill

Show skill metadata with:

```bash
moodle skills
```

Install from the published repository with:

```bash
moodle skills add
```

Extra arguments are passed to the shared `skills` CLI, for example `moodle skills add --agent codex`.

## Regenerate the Skill Bundle

Inside the `moodle-cli` source repository:

```bash
npm run build
npm run skill:generate
git diff -- SKILL.md references agents/openai.yaml
```

Regeneration is complete when the root skill, branch references, command reference, output contract, and agent metadata are all current.
