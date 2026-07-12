# Output and Errors

Read this file when choosing an output mode, filtering fields, consuming errors, or interpreting exit codes.

### Output Contract

- `--json` writes JSON to stdout.
- `--yaml` writes YAML to stdout when supported.
- `--table` forces human-readable table/tree output.
- When stdout is not a TTY, commands default to JSON unless `--table` is set.
- `--fields a,b,c` keeps only listed top-level fields. Arrays apply the field filter to each item.
- Invalid `--fields` values are usage errors and list valid fields.
- With JSON output enabled, errors are one JSON line on stderr: `{"error":true,"code":"auth_failed","message":"...","hint":"..."}`.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Authentication or configuration error |
| 3 | Usage error |
| 4 | Requested course, activity, forum, or discussion was not found |

## Agent Handling

- Parse structured stdout locally and return only the facts the user requested.
- Treat stderr as the error channel; JSON mode emits one parseable error object there.
- Use the exit code to distinguish authentication/configuration, usage, not-found, and unexpected failures.
- Retry only after acting on the error hint. A repeated authentication failure needs a fresh login or session source, not another identical command.
