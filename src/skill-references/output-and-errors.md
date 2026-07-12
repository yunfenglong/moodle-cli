# Output and Errors

Read this file when choosing an output mode, filtering fields, consuming errors, or interpreting exit codes.

{{generated_output_contract}}

## Agent Handling

- Parse structured stdout locally and return only the facts the user requested.
- Treat stderr as the error channel; JSON mode emits one parseable error object there.
- Use the exit code to distinguish authentication/configuration, usage, not-found, and unexpected failures.
- Retry only after acting on the error hint. A repeated authentication failure needs a fresh login or session source, not another identical command.
