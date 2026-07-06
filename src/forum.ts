import { AJAX_SERVICE_PATH, FORUM_DISCUSS_PATH, FORUM_VIEW_PATH, FUNC_GET_DISCUSSION_POSTS } from "./constants.js";
import { MoodleAPIError, NotFoundError, UsageError } from "./errors.js";
import { htmlToStructuredContent } from "./html-utils.js";
import type { Course, ForumActivityRef, ForumDiscussion, ForumPost, ForumPostAuthor, Section } from "./models.js";
import {
  parseForumDiscussionGroupHtml,
  parseForumDiscussionHtml,
  parseForumDiscussionRefsHtml,
  parseForumGroupsHtml,
  parseForumViewCmidFromDiscussionHtml,
} from "./scraper.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface MoodleForumClientOptions {
  baseUrl: string;
  sesskey?: string;
  fetch?: FetchLike;
  getCourses?: () => Promise<Course[]>;
  getCourseContents?: (courseId: number) => Promise<Section[]>;
}

export class MoodleForumClient {
  readonly baseUrl: string;
  private readonly sesskey: string;
  private readonly fetchImpl: FetchLike;
  private readonly loadCourses?: () => Promise<Course[]>;
  private readonly loadCourseContents?: (courseId: number) => Promise<Section[]>;
  private readonly forumDiscussionCache = new Map<number, ForumDiscussion>();
  private readonly forumDiscussionRefsCache = new Map<number, ForumDiscussionRef[]>();

  constructor(options: MoodleForumClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.sesskey = options.sesskey ?? "";
    this.fetchImpl = options.fetch ?? fetch;
    this.loadCourses = options.getCourses;
    this.loadCourseContents = options.getCourseContents;
  }

  async getForumDiscussion(discussionId: number): Promise<ForumDiscussion> {
    const cached = this.forumDiscussionCache.get(discussionId);
    if (cached) {
      return cached;
    }

    try {
      const data = await this.call(FUNC_GET_DISCUSSION_POSTS, {
        discussionid: discussionId,
        sortby: "created",
        sortdirection: "ASC",
        includeinlineattachments: true,
      });
      if (isRecord(data)) {
        const discussion = parseAjaxForumDiscussion(data, discussionId);
        if (discussion.group_id <= 0) {
          const html = await this.getPage(FORUM_DISCUSS_PATH, { d: discussionId }).catch(() => "");
          if (html) {
            const [groupId, groupName] = parseForumDiscussionGroupHtml(html);
            discussion.group_id = groupId;
            discussion.group_name = groupName;
          }
        }
        this.forumDiscussionCache.set(discussionId, discussion);
        return discussion;
      }
    } catch (error) {
      if (!shouldFallbackForumAjax(error)) {
        throw error;
      }
    }

    const html = await this.getPage(FORUM_DISCUSS_PATH, { d: discussionId });
    const discussion = parseForumDiscussionHtml(html, this.baseUrl, discussionId);
    this.forumDiscussionCache.set(discussionId, discussion);
    return discussion;
  }

  async getForumViewCmid(discussionId: number): Promise<number | null> {
    const html = await this.getPage(FORUM_DISCUSS_PATH, { d: discussionId });
    return parseForumViewCmidFromDiscussionHtml(html);
  }

  async getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]> {
    const cached = this.forumDiscussionRefsCache.get(forumCmid);
    if (cached) {
      return cached;
    }

    const html = await this.getPage(FORUM_VIEW_PATH, { id: forumCmid });
    const groups = parseForumGroupsHtml(html);
    const refs = groups.length ? [] : parseForumDiscussionRefsHtml(html, this.baseUrl);
    const seenIds = new Set(refs.map((ref) => ref.id));

    for (const [groupId, groupName] of groups) {
      const groupHtml = await this.getPage(FORUM_VIEW_PATH, { id: forumCmid, group: groupId });
      for (const ref of parseForumDiscussionRefsHtml(groupHtml, this.baseUrl)) {
        if (seenIds.has(ref.id)) {
          continue;
        }
        seenIds.add(ref.id);
        refs.push({ ...ref, group_id: groupId, group_name: groupName });
      }
    }

    this.forumDiscussionRefsCache.set(forumCmid, refs);
    return refs;
  }

  async getCourseForums(courseId: number, courseName = ""): Promise<ForumActivityRef[]> {
    if (!this.loadCourseContents) {
      throw new Error("getCourseContents loader is required to list course forums");
    }
    const sections = await this.loadCourseContents(courseId);
    return sections.flatMap((section) =>
      section.activities
        .filter((activity) => activity.modname === "forum")
        .map((activity) => ({
          id: activity.id,
          name: activity.name,
          course_id: courseId,
          course_name: courseName,
          url: activity.url,
        })),
    );
  }

  async getForums(courseId?: number): Promise<ForumActivityRef[]> {
    if (courseId !== undefined) {
      const courseName = await this.courseName(courseId);
      return this.getCourseForums(courseId, courseName);
    }
    if (!this.loadCourses) {
      throw new Error("getCourses loader is required to list all forums");
    }
    const forums: ForumActivityRef[] = [];
    for (const course of await this.loadCourses()) {
      forums.push(...(await this.getCourseForums(course.id, course.fullname || course.shortname)));
    }
    return forums;
  }

  private async courseName(courseId: number): Promise<string> {
    if (!this.loadCourses) {
      return "";
    }
    const course = (await this.loadCourses()).find((item) => item.id === courseId);
    return course ? course.fullname || course.shortname : "";
  }

  private async call(functionName: string, args: Record<string, unknown>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${AJAX_SERVICE_PATH}`);
    url.searchParams.set("sesskey", this.sesskey);
    url.searchParams.set("info", functionName);

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ index: 0, methodname: functionName, args }]),
    });
    if (!response.ok) {
      throw new Error(`Moodle request failed with HTTP ${response.status}`);
    }

    const result: unknown = await response.json();
    if (Array.isArray(result) && result.length > 0 && isRecord(result[0])) {
      const item = result[0];
      if (item.error) {
        const exception = isRecord(item.exception) ? item.exception : {};
        throw new MoodleAPIError(stringValue(exception.message) || "Unknown API error", stringValue(exception.errorcode) || undefined);
      }
      return item.data ?? item;
    }
    if (isRecord(result) && result.error) {
      throw new MoodleAPIError(stringValue(result.message) || "Unknown error", stringValue(result.errorcode) || undefined);
    }
    return result;
  }

  private async getPage(path: string, params: Record<string, string | number>): Promise<string> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Moodle request failed with HTTP ${response.status}`);
    }
    return response.text();
  }
}

export function parseDiscussionReference(value: string): { discussionId: number; postId: number | null } {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    return { discussionId: Number(raw), postId: null };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("DISCUSSION must be a numeric ID or a full discuss.php URL.");
  }

  const discussionValue = url.searchParams.get("d");
  if (!discussionValue || !/^\d+$/.test(discussionValue)) {
    throw new UsageError("Could not find discussion ID in URL query (expected ?d=...).");
  }

  const fragment = url.hash.replace(/^#/, "");
  const postId = /^p\d+$/.test(fragment) ? Number(fragment.slice(1)) : null;
  return { discussionId: Number(discussionValue), postId };
}

export async function parseForumReference(
  value: string,
  resolveForumCmid?: (discussionId: number) => Promise<number | null>,
): Promise<number> {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("FORUM must be a numeric ID or a full forum URL.");
  }

  if (url.pathname.endsWith("/mod/forum/view.php")) {
    const forumValue = url.searchParams.get("id");
    if (!forumValue || !/^\d+$/.test(forumValue)) {
      throw new UsageError("Could not find forum module ID in view.php URL (expected ?id=...).");
    }
    return Number(forumValue);
  }

  if (url.pathname.endsWith("/mod/forum/discuss.php")) {
    const discussionValue = url.searchParams.get("d");
    if (!discussionValue || !/^\d+$/.test(discussionValue)) {
      throw new UsageError("Could not find discussion ID in discuss.php URL (expected ?d=...).");
    }
    if (!resolveForumCmid) {
      throw new UsageError("A discuss.php URL needs a resolver to find the forum ID.");
    }
    const forumCmid = await resolveForumCmid(Number(discussionValue));
    if (!forumCmid) {
      throw new NotFoundError("Could not resolve forum ID from the discussion page.");
    }
    return forumCmid;
  }

  throw new UsageError("Unsupported forum URL. Use a view.php?id=... or discuss.php?d=... URL.");
}

export function filterDiscussionToPost(discussion: ForumDiscussion, postId: number | null | undefined): ForumDiscussion {
  if (postId == null) {
    return discussion;
  }
  const posts = discussion.posts.filter((post) => post.id === postId);
  if (!posts.length) {
    throw new NotFoundError(`Post ${postId} was not found in discussion ${discussion.id}.`);
  }
  return { ...discussion, posts };
}

function parseAjaxForumDiscussion(data: Record<string, unknown>, discussionId: number): ForumDiscussion {
  const posts = asArray(data.posts)
    .filter(isRecord)
    .map((post) => parseAjaxForumPost(post));
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

function parseAjaxForumPost(data: Record<string, unknown>): ForumPost {
  const urls = isRecord(data.urls) ? data.urls : {};
  const messageHtml = stringValue(data.message);
  const structured = htmlToStructuredContent(messageHtml, stringValue(urls.view) || stringValue(urls.discuss));
  return {
    id: numberValue(data.id),
    discussion_id: numberValue(data.discussionid),
    subject: stringValue(data.subject),
    message_html: messageHtml,
    message_text: structured.text,
    image_urls: structured.image_urls,
    links: structured.links,
    tables: structured.tables,
    author: parseAjaxForumPostAuthor(isRecord(data.author) ? data.author : {}),
    parent_id: numberValue(data.parentid),
    time_created: numberValue(data.timecreated),
    time_modified: numberValue(data.timemodified),
    created_pretty: "",
    unread: booleanValue(data.unread),
    is_deleted: booleanValue(data.isdeleted),
    is_private_reply: booleanValue(data.isprivatereply),
    url: stringValue(urls.view) || stringValue(urls.viewisolated),
    reply_url: stringValue(urls.reply),
  };
}

function parseAjaxForumPostAuthor(data: Record<string, unknown>): ForumPostAuthor {
  const urls = isRecord(data.urls) ? data.urls : {};
  return {
    id: numberValue(data.id),
    fullname: stringValue(data.fullname),
    profile_url: stringValue(urls.profile),
    profile_image_url: stringValue(urls.profileimage),
  };
}

function shouldFallbackForumAjax(error: unknown): boolean {
  if (!(error instanceof MoodleAPIError)) {
    return false;
  }
  return (
    error.moodleErrorCode === "servicenotavailable" ||
    error.moodleErrorCode === "accessexception" ||
    error.message.includes("Web service is not available")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function booleanValue(value: unknown): boolean {
  return Boolean(value);
}

interface ForumDiscussionRef {
  id: number;
  subject: string;
  group_id: number;
  group_name: string;
  url: string;
}
