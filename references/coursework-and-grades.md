# Coursework and Grades

Read this file for grades or detail about assignments, quizzes, resources, links, pages, and folders.

## Grades

Use a course ID or unique course name:

```bash
moodle grades COURSE --json
```

Report the course total and requested grade items. Preserve displayed values and percentages; Moodle gradebooks may expose text such as ranges, letters, or incomplete totals.

## Activity Detail

Each command accepts a numeric module ID or its full Moodle URL:

| Activity | Command |
| --- | --- |
| Assignment | `moodle assign ASSIGNMENT --json` |
| Quiz | `moodle quiz QUIZ --json` |
| File/resource | `moodle resource RESOURCE --json` |
| External link | `moodle link LINK --json` |
| Moodle page | `moodle page PAGE --json` |
| Folder | `moodle folder FOLDER --json` |

Download a Page body and its Moodle-hosted attachments with either its numeric course-module ID or full URL:

```bash
moodle download PAGE --dir ./notes
```

The result contains `Page name.md` and `Page name.assets/`. Course downloads and exports include Page attachments as well.

Download one numbered course section by course code and week:

```bash
moodle download FIT1061 1 --dir ./w1
```

This downloads resource, folder, and Page content only from Moodle section 1.

When the user supplies a supported Moodle URL without naming a command, route it directly:

```bash
moodle 'MOODLE_URL' --json
```

The CLI recognizes course, grade report, forum, assignment, quiz, resource, link, page, and folder URLs. For another activity URL, it may fall back to the containing course.

## Agent Steps

1. Use the activity-specific command when the activity type is known.
2. Use direct URL routing when the user already supplied a URL and only wants its content.
3. Return structured links and files from the result instead of scraping prose from the formatted table.

The branch is complete when the answer identifies the course or module and quotes the grade or activity state returned by Moodle.
