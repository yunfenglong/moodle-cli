import { FORUM_DISCUSS_PATH, FORUM_VIEW_PATH, FUNC_GET_DISCUSSION_POSTS } from "./constants.js";
import { MoodleAPIError, NotFoundError, UsageError } from "./errors.js";
import type { Course, ForumActivityRef, ForumDiscussion, ForumDiscussionRef, Section } from "./models.js";
import { parseForumDiscussion } from "./parsers.js";
import {
  parseForumDiscussionGroupHtml,
  parseForumDiscussionHtml,
  parseForumDiscussionRefsHtml,
  parseForumGroupsHtml,
  parseForumViewCmidFromDiscussionHtml,
} from "./scraper.js";

export interface ForumAdapter {
  baseUrl: string;
  call: (functionName: string, args: Record<string, unknown>) => Promise<unknown>;
  getPage: (path: string, params: Record<string, string | number>) => Promise<string>;
  getCourses?: () => Promise<Course[]>;
  getCourseContents?: (courseId: number) => Promise<Section[]>;
}

export class ForumModule {
  readonly baseUrl: string;
  private readonly callMoodle: ForumAdapter["call"];
  private readonly loadPage: ForumAdapter["getPage"];
  private readonly loadCourses?: () => Promise<Course[]>;
  private readonly loadCourseContents?: (courseId: number) => Promise<Section[]>;
  private readonly forumDiscussionCache = new Map<number, ForumDiscussion>();
  private readonly forumDiscussionRefsCache = new Map<number, ForumDiscussionRef[]>();

  constructor(options: ForumAdapter) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.callMoodle = options.call;
    this.loadPage = options.getPage;
    this.loadCourses = options.getCourses;
    this.loadCourseContents = options.getCourseContents;
  }

  async getForumDiscussion(discussionId: number): Promise<ForumDiscussion> {
    const cached = this.forumDiscussionCache.get(discussionId);
    if (cached) {
      return cached;
    }

    try {
      const data = await this.callMoodle(FUNC_GET_DISCUSSION_POSTS, {
        discussionid: discussionId,
        sortby: "created",
        sortdirection: "ASC",
        includeinlineattachments: true,
      });
      const discussion = parseForumDiscussion(data, discussionId, this.baseUrl);
      if (discussion.group_id <= 0) {
        const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussionId }).catch(() => "");
        if (html) {
          const [groupId, groupName] = parseForumDiscussionGroupHtml(html);
          discussion.group_id = groupId;
          discussion.group_name = groupName;
        }
      }
      this.forumDiscussionCache.set(discussionId, discussion);
      return discussion;
    } catch (error) {
      if (!shouldFallbackForumAjax(error)) {
        throw error;
      }
    }

    const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussionId });
    const discussion = parseForumDiscussionHtml(html, this.baseUrl, discussionId);
    this.forumDiscussionCache.set(discussionId, discussion);
    return discussion;
  }

  async getForumViewCmid(discussionId: number): Promise<number | null> {
    const html = await this.loadPage(FORUM_DISCUSS_PATH, { d: discussionId });
    return parseForumViewCmidFromDiscussionHtml(html);
  }

  async getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]> {
    const cached = this.forumDiscussionRefsCache.get(forumCmid);
    if (cached) {
      return cached;
    }

    const html = await this.loadPage(FORUM_VIEW_PATH, { id: forumCmid });
    const groups = parseForumGroupsHtml(html);
    const refs = groups.length ? [] : parseForumDiscussionRefsHtml(html, this.baseUrl);
    const seenIds = new Set(refs.map((ref) => ref.id));

    for (const [groupId, groupName] of groups) {
      const groupHtml = await this.loadPage(FORUM_VIEW_PATH, { id: forumCmid, group: groupId });
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

  private async getCourseForums(courseId: number, courseName = ""): Promise<ForumActivityRef[]> {
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
