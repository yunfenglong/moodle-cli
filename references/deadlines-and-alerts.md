# Deadlines and Alerts

Read this file for upcoming work, due dates, notifications, unread counts, or a combined snapshot.

## Choose the Command

| Need | Command |
| --- | --- |
| Nearest actionable items | `moodle todo --limit 5 --days 14 --json` |
| Notifications and message counts | `moodle alerts --limit 10 --json` |
| User, courses, todo, and alerts together | `moodle overview --todo-limit 5 --alerts-limit 5 --json` |

Use `todo` for “next,” “due,” “deadline,” and “upcoming.” Add `--days N` for a time window and `--limit N` for result size.

Use `alerts` for notifications, unread items, starred messages, and conversation counts.

Use `overview` only when the user explicitly wants multiple categories in one snapshot. A narrow request should stay on `todo` or `alerts`.

## Agent Steps

1. Run the narrow command.
2. Sort or filter the returned data only when the command does not already express the request.
3. Report exact timestamps and course/activity names; preserve the Moodle URL when it helps the user act.

The branch is complete when every reported deadline or alert comes from the command result and the requested time window is explicit.
