import type {
  Activity,
  ActivityDetail,
  AlertSummary,
  AssignSubmitResult,
  CalendarEvent,
  ChoiceInfo,
  CompletionResult,
  Conversation,
  ConversationDetail,
  Course,
  CourseExportSummary,
  CourseGrades,
  CourseSearchHit,
  DownloadResult,
  FeedbackInfo,
  FeedbackSubmitResult,
  ForumActivityRef,
  ForumCheckResult,
  ForumDiscussion,
  ForumDiscussionRef,
  ForumSearchHit,
  GradeOverviewRow,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import type { AuthStatus, KeepaliveRunResult } from "./keepalive.js";

export function formatUser(user: UserInfo): string {
  return formatKeyValues([
    ["User", user.fullname],
    ["Username", user.username],
    ["User ID", String(user.userid)],
    ["Site", user.sitename],
    ["URL", user.siteurl],
    ["Language", user.lang ?? ""],
  ]);
}

export function formatCourses(courses: Course[]): string {
  return formatColumns([["ID", "Short Name", "Full Name"], ...courses.map((course) => [String(course.id), course.shortname, course.fullname])]);
}

export function formatCourseSections(sections: Section[]): string {
  const lines = ["Course"];
  for (const section of sections) {
    lines.push(`  ${section.name || `Section ${section.section}`}${section.visible ? "" : " (hidden)"}`);
    if (!section.activities.length) {
      lines.push("    No activities");
      continue;
    }
    for (const activity of section.activities) {
      lines.push(`    ${activity.name}${activity.visible ? "" : " (hidden)"} (${activity.modname})`);
    }
  }
  return lines.join("\n");
}

export function formatActivityList(value: Section[] | Activity[]): string {
  const activities = Array.isArray(value) && value[0] && "activities" in value[0]
    ? (value as Section[]).flatMap((section) => section.activities)
    : (value as Activity[]);
  return formatColumns([["ID", "Type", "Name"], ...activities.map((activity) => [String(activity.id), activity.modname, activity.name])]);
}

export function formatTodo(items: TodoItem[]): string {
  if (!items.length) {
    return "No upcoming items";
  }
  return formatColumns([
    ["Due", "Course", "Activity", "Type", "Action"],
    ...items.map((item) => [
      item.due_at ? String(item.due_at) : "-",
      item.course_name,
      item.activity_name || item.name,
      item.modname || item.event_type,
      item.actionable ? item.action_name : "",
    ]),
  ]);
}

export function formatAlerts(alerts: AlertSummary): string {
  const lines = [
    `Notifications: ${alerts.notification_count}`,
    `Unread notifications: ${alerts.unread_notification_count}`,
    `Direct messages: ${alerts.direct_message_count}`,
    `Unread direct messages: ${alerts.unread_direct_message_count}`,
  ];
  for (const notification of alerts.notifications) {
    lines.push(`${notification.created_pretty || notification.created_at} ${notification.short_subject || notification.subject}`);
  }
  return lines.join("\n");
}

export function formatGrades(grades: CourseGrades): string {
  return formatColumns([
    ["Item", "Grade", "Range", "Percent", "Feedback"],
    ...grades.items.map((item) => [item.name, item.grade, item.range, item.percentage, item.feedback]),
  ]);
}

export function formatAssignSubmitResult(result: AssignSubmitResult): string {
  const lines = result.uploaded.map((file) => `Uploaded ${file.file} (${formatBytes(file.bytes)})`);
  lines.push(result.submitted_for_grading ? "Submitted for grading (locked)" : "Submission saved");
  if (result.submission_statement) {
    lines.push(`Accepted statement: ${result.submission_statement}`);
  }
  if (result.submission_status) {
    lines.push(`Status: ${result.submission_status}`);
  }
  return lines.join("\n");
}

export function formatChoice(info: ChoiceInfo): string {
  const lines = [`Choice ${info.id}${info.name ? `: ${info.name}` : ""}`];
  lines.push(info.can_vote ? `Voting open${info.multiple ? " (multiple answers allowed)" : ""}` : "Voting not available");
  for (const option of info.options) {
    lines.push(`${option.selected ? "*" : "-"} ${option.id}  ${option.text}`);
  }
  if (!info.options.length) {
    lines.push("No options visible");
  }
  return lines.join("\n");
}

export function formatFeedbackInfo(info: FeedbackInfo): string {
  const lines = [`Feedback ${info.id}${info.name ? `: ${info.name}` : ""}`];
  if (!info.questions.length) {
    lines.push("No questions visible (closed or already completed)");
    return lines.join("\n");
  }
  for (const question of info.questions) {
    lines.push(`${question.item_id}  [${question.type}]${question.required ? " (required)" : ""}  ${question.label}`);
    for (const option of question.options) {
      lines.push(`     ${option.value}: ${option.text}`);
    }
  }
  if (info.has_more_pages) {
    lines.push("(more pages follow; answer with --answer <id>=<value> to progress through them)");
  }
  return lines.join("\n");
}

export function formatFeedbackResult(result: FeedbackSubmitResult): string {
  return `Feedback ${result.id} completed (${result.pages_submitted} page${result.pages_submitted === 1 ? "" : "s"}): ${result.message}`;
}

export function formatCompletionResult(result: CompletionResult): string {
  return result.updated
    ? `Activity ${result.cmid} marked as ${result.completed ? "complete" : "incomplete"}`
    : `Could not update completion for activity ${result.cmid} (manual completion may not be enabled)`;
}

export function formatCalendarEvents(events: CalendarEvent[]): string {
  if (!events.length) {
    return "No calendar events";
  }
  return formatColumns([
    ["When", "Course", "Event", "Type"],
    ...events.map((event) => [
      formatTimestamp(event.starts_at),
      event.course_name,
      event.name,
      event.modname || event.event_type,
    ]),
  ]);
}

export function formatCourseSearchHits(hits: CourseSearchHit[]): string {
  if (!hits.length) {
    return "No matches";
  }
  return [
    "Course Search",
    ...hits.map((hit) =>
      [
        hit.course_name,
        hit.section_name,
        hit.activity_name || "(section)",
        hit.modname,
        hit.matched_in,
        hit.snippet,
        hit.url,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

export function formatCourseExport(summary: CourseExportSummary): string {
  const lines = [
    `Exported '${summary.course_name}' to ${summary.dir}`,
    `Sections: ${summary.sections}  Pages: ${summary.pages}  Links: ${summary.links}  Files: ${summary.files.length}`,
  ];
  const failed = summary.files.filter((file) => file.status === "failed");
  for (const file of failed) {
    lines.push(`Failed ${file.name}: ${file.error ?? "unknown error"}`);
  }
  return lines.join("\n");
}

export function formatGradesOverview(rows: GradeOverviewRow[]): string {
  if (!rows.length) {
    return "No course grades available";
  }
  return formatColumns([
    ["ID", "Course", "Grade"],
    ...rows.map((row) => [String(row.course_id), row.course_name, row.grade || "-"]),
  ]);
}

export function formatConversations(conversations: Conversation[]): string {
  if (!conversations.length) {
    return "No conversations";
  }
  return formatColumns([
    ["ID", "Unread", "Type", "With", "Last message"],
    ...conversations.map((conversation) => [
      String(conversation.id),
      conversation.unread_count ? String(conversation.unread_count) : "",
      conversation.type,
      conversation.name,
      [conversation.last_sender, preview(conversation.last_message, 60)].filter(Boolean).join(": "),
    ]),
  ]);
}

export function formatConversationDetail(detail: ConversationDetail): string {
  const lines = [`Conversation ${detail.id}${detail.name ? `: ${detail.name}` : ""}`];
  if (!detail.messages.length) {
    lines.push("No messages");
    return lines.join("\n");
  }
  for (const message of detail.messages) {
    lines.push(`${formatTimestamp(message.sent_at)}  ${message.sender_name || message.sender_id}: ${message.text}`);
  }
  return lines.join("\n");
}

export function formatDownloadResults(results: DownloadResult[]): string {
  if (!results.length) {
    return "No downloadable files found";
  }
  const lines = results.map((result) => {
    switch (result.status) {
      case "downloaded":
        return `Downloaded ${result.file} (${formatBytes(result.bytes)})`;
      case "exists":
        return `Skipped ${result.file} (already exists; use --force to overwrite)`;
      case "planned":
        return `Would download ${result.name} <- ${result.url}`;
      case "failed":
        return `Failed ${result.name}: ${result.error ?? "unknown error"}`;
    }
  });
  const downloaded = results.filter((result) => result.status === "downloaded").length;
  const failed = results.filter((result) => result.status === "failed").length;
  if (results.length > 1) {
    lines.push(`${downloaded} downloaded, ${results.length - downloaded - failed} skipped, ${failed} failed`);
  }
  return lines.join("\n");
}

export function formatActivityDetail(activity: ActivityDetail): string {
  const rows = Object.entries(activity)
    .filter(([, value]) => value !== "" && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)] as [string, string]);
  return formatKeyValues(rows);
}

export function formatForumDiscussion(
  discussion: ForumDiscussion,
  options: { highlightPostId?: number | null; showBody?: boolean } = {},
): string {
  const lines = [`Discussion: ${discussion.id}`];
  if (discussion.subject) {
    lines.push(`Subject: ${discussion.subject}`);
  }
  if (discussion.url) {
    lines.push(`URL: ${discussion.url}`);
  }
  if (discussion.course_id) {
    lines.push(`Course ID: ${discussion.course_id}`);
  }
  if (discussion.forum_id) {
    lines.push(`Forum ID: ${discussion.forum_id}`);
  }

  if (!discussion.posts.length) {
    lines.push("", "No posts");
    return lines.join("\n");
  }

  for (const post of discussion.posts) {
    const marker = options.highlightPostId === post.id ? "*" : "-";
    lines.push("", `${marker} Post ${post.id}`);
    lines.push(`  Author: ${post.author.fullname || "-"}`);
    lines.push(`  When: ${post.created_pretty || (post.time_created ? String(post.time_created) : "-")}`);
    if (post.subject) {
      lines.push(`  Subject: ${post.subject}`);
    }
    if (post.url) {
      lines.push(`  URL: ${post.url}`);
    }
    if (options.showBody) {
      if (post.message_text) {
        lines.push("", post.message_text);
      }
      if (post.image_urls.length) {
        lines.push("", "Images:", ...post.image_urls.map((url) => `- ${url}`));
      }
    } else {
      lines.push(`  Preview: ${preview(post.message_text)}`);
      lines.push(`  Images: ${post.image_urls.length}`);
    }
  }

  return lines.join("\n");
}

export function formatForumDiscussionRefs(forumCmid: number, refs: ForumDiscussionRef[]): string {
  const lines = [`Forum ${forumCmid}: Discussions`];
  if (!refs.length) {
    return `${lines[0]}\nNo discussions`;
  }
  for (const ref of refs) {
    lines.push([ref.id, ref.subject, ref.group_name, ref.url].filter(Boolean).join(" | "));
  }
  return lines.join("\n");
}

export function formatForumActivities(forums: ForumActivityRef[]): string {
  if (!forums.length) {
    return "Forums\nNo forums";
  }
  return [
    "Forums",
    ...forums.map((forum) => [forum.id, forum.name, forum.course_name, forum.course_id || "", forum.url].filter(Boolean).join(" | ")),
  ].join("\n");
}

export function formatForumSearchHits(hits: ForumSearchHit[]): string {
  if (!hits.length) {
    return "Forum Search\nNo matches";
  }
  return [
    "Forum Search",
    ...hits.map((hit) =>
      [
        hit.course_name,
        hit.forum_name,
        hit.discussion_subject,
        hit.discussion_id || "",
        hit.post_id || "",
        hit.matched_in,
        hit.author_name,
        hit.snippet || hit.discussion_subject,
        hit.url,
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ].join("\n");
}

export function formatForumCheckResults(forumCmid: number, rows: ForumCheckResult[]): string {
  const lines = [`Forum ${forumCmid}: Discussion Check (first ${rows.length})`];
  for (const row of rows) {
    lines.push(
      row.ok
        ? `${row.discussion_id} | Yes | ${row.posts ?? ""} | ${row.images ?? ""} | ${row.subject}`
        : `${row.discussion_id} | No | ${row.subject} | ${row.error ?? ""}`,
    );
  }
  return lines.join("\n");
}

export function formatAuthStatus(status: AuthStatus): string {
  return formatKeyValues([
    ["Site", status.base_url],
    ["Cached session", status.session_cached ? "yes" : "no"],
    ["Cache age", status.cache_age_minutes === null ? "" : `${status.cache_age_minutes} min`],
    ["Session alive", status.session_alive === null ? (status.session_cached ? "unknown" : "") : status.session_alive ? "yes" : "no"],
    ["Server timeout in", formatDuration(status.session_time_remaining_seconds)],
    ["Keepalive agent", status.keepalive_installed ? `installed (${status.keepalive_plist_path})` : "not installed"],
  ]);
}

export function formatKeepaliveResult(result: KeepaliveRunResult): string {
  switch (result.status) {
    case "renewed":
      return `Session renewed${result.time_remaining_seconds ? `; server timeout in ${formatDuration(result.time_remaining_seconds)}` : ""}`;
    case "reauthenticated":
      return "Session was expired; re-authenticated from browser/okta cookies";
    case "expired":
      return "Session expired and could not be renewed. Log in to Moodle in your browser or run: moodle auth login";
    case "no_session":
      return "No cached session to renew. Run any moodle command once, or: moodle auth login";
    case "unreachable":
      return "Could not reach the Moodle site; session state unchanged";
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "";
  }
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} min`;
  }
  return `${(minutes / 60).toFixed(1)} h`;
}

function formatTimestamp(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "-";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function preview(value: string, maxLen = 100): string {
  const cleaned = value.split(/\s+/).filter(Boolean).join(" ");
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
}

function formatKeyValues(rows: Array<[string, string]>): string {
  const present = rows.filter(([, value]) => value);
  const width = Math.max(0, ...present.map(([key]) => key.length));
  return present.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

function formatColumns(rows: string[][]): string {
  if (!rows.length) {
    return "";
  }
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
}
