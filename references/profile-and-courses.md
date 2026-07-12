# Profile and Courses

Read this file for identity, enrolled-course discovery, course sections, or course activity lists.

## Choose the Command

| Need | Command |
| --- | --- |
| Authenticated user and site | `moodle user --json` |
| Enrolled courses | `moodle courses --json` |
| Sections and nested activities | `moodle course COURSE --json` |
| Flat activity list | `moodle activities COURSE --json` |

`COURSE` accepts a numeric course ID or a unique course-name match. When a name could match several courses, run `moodle courses --json`, identify the intended course, and continue with its ID.

## Agent Steps

1. Use `user` only for account or site identity.
2. Use `courses` for discovery and ID resolution.
3. Use `course` when section placement matters; use `activities` when the user wants a flat inventory.
4. Use `--fields` only for fields present in the returned objects, for example:

```bash
moodle courses --json --fields id,shortname,fullname
```

The branch is complete when the requested course or activity facts are tied to an unambiguous course ID.
