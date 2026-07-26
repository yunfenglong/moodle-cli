import type {
  Activity,
  AlertNotification,
  AlertSummary,
  CalendarEvent,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  Course,
  ForumDiscussion,
  ForumPost,
  ForumPostAuthor,
  GradeOverviewRow,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import { htmlToStructuredContent } from "./html-utils.js";

type AnyRecord = Record<string, unknown>;

export interface ParserSchema<T> {
  parse(value: unknown): T;
}

function schema<T>(parser: (value: unknown) => T): ParserSchema<T> {
  return { parse: parser };
}

export const UserInfoSchema = schema(parseUserInfo);
export const CourseSchema = schema(parseCourse);
export const CoursesSchema = schema(parseCourses);
export const ActivitySchema = schema(parseActivity);
export const SectionSchema = schema(parseSection);
export const CourseContentsSchema = schema(parseCourseContents);
export const TodoItemSchema = schema(parseTodoItem);

export function parseUserInfo(value: unknown): UserInfo {
  const data = asRecord(value);
  return {
    userid: numberValue(data.userid),
    username: stringValue(data.username),
    fullname: stringValue(data.fullname),
    sitename: stringValue(data.sitename),
    siteurl: stringValue(data.siteurl),
    lang: stringValue(data.lang),
  };
}

export function parseCourse(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): Course {
  const data = asRecord(value);
  const course: Course = {
    id: numberValue(data.id),
    shortname: stringValue(data.shortname),
    fullname: stringValue(data.fullname),
    category: numberValue(data.category),
    visible: booleanValue(data.visible, true),
    startdate: numberValue(data.startdate),
  };
  const enddate = numberValue(data.enddate);
  if (enddate > nowSeconds) {
    course.enddate = enddate;
  }
  return course;
}

export function parseCourses(value: unknown): Course[] {
  return asArray(value).map((item) => parseCourse(item));
}

export function parseActivity(value: unknown): Activity {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    modname: stringValue(data.modname),
    url: stringValue(data.url),
    visible: booleanValue(data.visible, true),
    description: stringValue(data.description),
  };
}

export function parseSection(value: unknown): Section {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    section: numberValue(data.section),
    visible: booleanValue(data.visible, true),
    summary: stringValue(data.summary),
    activities: asArray(data.modules).map((item) => parseActivity(item)),
  };
}

export function parseCourseContents(value: unknown): Section[] {
  return asArray(value).map((item) => parseSection(item));
}

export function flattenActivities(sections: Section[]): Activity[] {
  return sections.flatMap((section) => section.activities);
}

export function parseTodoItem(value: unknown): TodoItem {
  const data = asRecord(value);
  const course = asRecord(data.course);
  const action = asRecord(data.action);
  const progress = course.progress;
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    activity_name: stringValue(data.activityname),
    modname: stringValue(data.modulename),
    course_id: numberValue(course.id),
    course_name: stringValue(course.fullname),
    due_at: numberValue(data.timesort) || numberValue(data.timestart),
    overdue: booleanValue(data.overdue),
    actionable: booleanValue(action.actionable),
    action_name: stringValue(action.name),
    action_url: stringValue(action.url),
    url: stringValue(data.url),
    event_type: stringValue(data.eventtype),
    course_progress: typeof progress === "number" ? progress : undefined,
  };
}

export function parseTodoItems(value: unknown): TodoItem[] {
  return asArray(value).map((item) => parseTodoItem(item));
}

export function parseAlertNotification(value: unknown): AlertNotification {
  const data = asRecord(value);
  return {
    id: numberValue(data.id),
    subject: stringValue(data.subject),
    short_subject: stringValue(data.shortenedsubject),
    event_type: stringValue(data.eventtype),
    component: stringValue(data.component),
    created_at: numberValue(data.timecreated),
    created_pretty: stringValue(data.timecreatedpretty),
    read: booleanValue(data.read),
    context_url: stringValue(data.contexturl),
    context_name: stringValue(data.contexturlname),
  };
}

export function parseAlertSummary(
  notificationsData: unknown,
  countsData: unknown,
  unreadCountsData: unknown,
): AlertSummary {
  const notificationsRecord = asRecord(notificationsData);
  const counts = asRecord(countsData);
  const unreadCounts = asRecord(unreadCountsData);
  const types = asRecord(counts.types);
  const unreadTypes = asRecord(unreadCounts.types);
  const notifications = asArray(notificationsRecord.notifications).map((item) => parseAlertNotification(item));

  return {
    notifications,
    notification_count: notifications.length,
    unread_notification_count: notifications.filter((notification) => !notification.read).length,
    starred_message_count: numberValue(counts.favourites),
    direct_message_count: numberValue(types["1"]),
    group_message_count: numberValue(types["2"]),
    self_message_count: numberValue(types["3"]),
    unread_starred_message_count: numberValue(unreadCounts.favourites),
    unread_direct_message_count: numberValue(unreadTypes["1"]),
    unread_group_message_count: numberValue(unreadTypes["2"]),
    unread_self_message_count: numberValue(unreadTypes["3"]),
  };
}

export function parseCalendarEvent(value: unknown): CalendarEvent {
  const data = asRecord(value);
  const course = asRecord(data.course);
  const start = numberValue(data.timestart);
  const duration = numberValue(data.timeduration);
  return {
    id: numberValue(data.id),
    name: stringValue(data.name),
    description: htmlToStructuredContent(stringValue(data.description), "").text,
    course_id: numberValue(course.id),
    course_name: stringValue(course.fullname),
    modname: stringValue(data.modulename),
    event_type: stringValue(data.eventtype),
    starts_at: start,
    ends_at: duration > 0 ? start + duration : start,
    location: stringValue(data.location),
    url: stringValue(data.url) || stringValue(data.viewurl),
  };
}

export function parseCalendarEvents(value: unknown): CalendarEvent[] {
  return asArray(value).map((item) => parseCalendarEvent(item));
}

export function parseGradeOverviewGrades(value: unknown, courseNames: Map<number, string>, baseUrl: string): GradeOverviewRow[] {
  const data = asRecord(value);
  return asArray(data.grades)
    .map((item) => {
      const grade = asRecord(item);
      const courseId = numberValue(grade.courseid);
      return {
        course_id: courseId,
        course_name: courseNames.get(courseId) ?? "",
        grade: stringValue(grade.grade),
        url: courseId ? `${baseUrl.replace(/\/$/, "")}/course/user.php?mode=grade&id=${courseId}` : "",
      };
    })
    .filter((row) => row.course_id > 0);
}

const CONVERSATION_TYPES: Record<number, string> = { 1: "direct", 2: "group", 3: "self" };

export function parseConversations(value: unknown, currentUserId: number, baseUrl: string): Conversation[] {
  const data = asRecord(value);
  return asArray(data.conversations).map((item) => {
    const conversation = asRecord(item);
    const members = asArray(conversation.members).map((member) => asRecord(member));
    const others = members.filter((member) => numberValue(member.id) !== currentUserId);
    const lastMessage = asRecord(asArray(conversation.messages)[0]);
    const senderId = numberValue(lastMessage.useridfrom);
    return {
      id: numberValue(conversation.id),
      name: stringValue(conversation.name) || others.map((member) => stringValue(member.fullname)).filter(Boolean).join(", "),
      type: CONVERSATION_TYPES[numberValue(conversation.type)] ?? String(conversation.type ?? ""),
      member_count: numberValue(conversation.membercount),
      unread_count: numberValue(conversation.unreadcount),
      is_favourite: booleanValue(conversation.isfavourite),
      last_message: htmlToStructuredContent(stringValue(lastMessage.text), baseUrl).text,
      last_message_at: numberValue(lastMessage.timecreated),
      last_sender: senderId === currentUserId ? "me" : stringValue(members.find((member) => numberValue(member.id) === senderId)?.fullname),
    };
  });
}

export function parseConversationDetail(value: unknown, conversationId: number, currentUserId: number, baseUrl: string): ConversationDetail {
  const data = asRecord(value);
  const members = asArray(data.members).map((member) => asRecord(member));
  const names = new Map(members.map((member) => [numberValue(member.id), stringValue(member.fullname)]));
  const messages: ConversationMessage[] = asArray(data.messages)
    .map((item) => {
      const message = asRecord(item);
      const senderId = numberValue(message.useridfrom);
      return {
        id: numberValue(message.id),
        sender_id: senderId,
        sender_name: senderId === currentUserId ? "me" : names.get(senderId) ?? "",
        text: htmlToStructuredContent(stringValue(message.text), baseUrl).text,
        sent_at: numberValue(message.timecreated),
      };
    })
    .sort((a, b) => a.sent_at - b.sent_at);
  return {
    id: numberValue(data.id) || conversationId,
    name: stringValue(data.name) || members.filter((member) => numberValue(member.id) !== currentUserId).map((member) => stringValue(member.fullname)).filter(Boolean).join(", "),
    member_count: members.length,
    messages,
  };
}

export function parseForumPostAuthor(value: unknown): ForumPostAuthor {
  const data = asRecord(value);
  const urls = asRecord(data.urls);
  return {
    id: numberValue(data.id),
    fullname: stringValue(data.fullname),
    profile_url: stringValue(urls.profile),
    profile_image_url: stringValue(urls.profileimage),
  };
}

export function parseForumPost(value: unknown, baseUrl = ""): ForumPost {
  const data = asRecord(value);
  const urls = asRecord(data.urls);
  const messageHtml = stringValue(data.message);
  const structured = htmlToStructuredContent(messageHtml, stringValue(urls.view || urls.discuss) || baseUrl);
  return {
    id: numberValue(data.id),
    discussion_id: numberValue(data.discussionid),
    subject: stringValue(data.subject),
    message_html: messageHtml,
    message_text: structured.text,
    image_urls: structured.image_urls,
    links: structured.links,
    tables: structured.tables,
    author: parseForumPostAuthor(data.author),
    parent_id: numberValue(data.parentid),
    time_created: numberValue(data.timecreated),
    time_modified: numberValue(data.timemodified),
    created_pretty: "",
    unread: booleanValue(data.unread),
    is_deleted: booleanValue(data.isdeleted),
    is_private_reply: booleanValue(data.isprivatereply),
    url: stringValue(urls.view || urls.viewisolated),
    reply_url: stringValue(urls.reply),
  };
}

export function parseForumDiscussion(value: unknown, discussionId: number, baseUrl = ""): ForumDiscussion {
  const data = asRecord(value);
  const posts = asArray(data.posts).map((item) => parseForumPost(item, baseUrl));
  return {
    id: discussionId,
    subject: posts[0]?.subject ?? "",
    course_id: numberValue(data.courseid),
    forum_id: numberValue(data.forumid),
    group_id: numberValue(data.groupid),
    group_name: stringValue(data.groupname),
    url: posts[0]?.url ? posts[0].url.split("#", 1)[0] : "",
    posts,
  };
}

export function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

export function booleanValue(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return Boolean(value);
}
