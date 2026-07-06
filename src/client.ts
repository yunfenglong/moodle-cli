import { z } from "zod";
import {
  AJAX_SERVICE_PATH,
  ASSIGN_VIEW_PATH,
  COURSE_PATH,
  DASHBOARD_PATH,
  FOLDER_VIEW_PATH,
  FORUM_DISCUSS_PATH,
  FORUM_VIEW_PATH,
  FUNC_GET_ACTION_EVENTS,
  FUNC_GET_CONVERSATION_COUNTS,
  FUNC_GET_COURSE_CONTENTS,
  FUNC_GET_COURSES,
  FUNC_GET_COURSES_BY_TIMELINE,
  FUNC_GET_DISCUSSION_POSTS,
  FUNC_GET_POPUP_NOTIFICATIONS,
  FUNC_GET_SITE_INFO,
  FUNC_GET_UNREAD_CONVERSATION_COUNTS,
  GRADE_REPORT_INDEX_PATH,
  GRADE_REPORT_OVERVIEW_PATH,
  GRADE_REPORT_PATH,
  PAGE_VIEW_PATH,
  QUIZ_VIEW_PATH,
  RESOURCE_VIEW_PATH,
  URL_VIEW_PATH,
} from "./constants.js";
import { getAuthenticatedSession, type AuthOptions, type AuthenticatedSession, type MoodleSessionCookie } from "./auth.js";
import { isLoginRequiredError, MoodleAPIError, NotFoundError } from "./errors.js";
import type {
  AlertSummary,
  Assignment,
  Course,
  CourseGrades,
  Folder,
  ForumActivityRef,
  ForumDiscussion,
  ForumDiscussionRef,
  ForumSearchHit,
  Link,
  Overview,
  Page,
  PageContext,
  Quiz,
  Resource,
  Section,
  TodoItem,
  UserInfo,
} from "./models.js";
import {
  parseAlertSummary,
  parseCourseContents,
  parseCourses,
  parseForumDiscussion,
  parseTodoItems,
  parseUserInfo,
} from "./parsers.js";
import {
  hasCourseGradesHtml,
  parseAssignmentHtml,
  parseCourseContentsHtml,
  parseCourseGradesHtml,
  parseCourseGradesUrl,
  parseCourseIdFromPageHtml,
  parseCourseSectionNumbers,
  parseFolderHtml,
  parseForumDiscussionGroupHtml,
  parseForumDiscussionHtml,
  parseForumDiscussionRefsHtml,
  parseForumGroupsHtml,
  parseForumViewCmidFromDiscussionHtml,
  parseGradeOverviewRows,
  parseLinkHtml,
  parsePageContext,
  parsePageHtml,
  parseQuizHtml,
  parseResourceHtml,
} from "./scraper.js";
import { deleteCachedSession, readCachedSession, writeCachedSession, type SessionCacheOptions } from "./session-cache.js";

export { MoodleAPIError };

export interface AjaxCall {
  methodname: string;
  args?: Record<string, unknown>;
}

export type AjaxBatchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: MoodleAPIError };

interface ClientOptions {
  fetchImpl?: typeof fetch;
  cookie: MoodleSessionCookie;
  pageContext?: PageContext;
  cacheOptions?: SessionCacheOptions;
  onLoginRequired?: () => Promise<{ cookie: MoodleSessionCookie; pageContext: PageContext }>;
}

const AjaxEnvelopeSchema = z.array(
  z.object({
    error: z.boolean().optional(),
    data: z.unknown().optional(),
    exception: z
      .object({
        message: z.string().optional(),
        errorcode: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }).passthrough(),
);

export class MoodleClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch;
  private cookie: MoodleSessionCookie;
  private sesskey: string | null;
  private userid: number | null;
  private userInfo: UserInfo | null;
  private cacheOptions?: SessionCacheOptions;
  private onLoginRequired?: () => Promise<{ cookie: MoodleSessionCookie; pageContext: PageContext }>;
  private retryingLogin = false;
  private forumDiscussions = new Map<number, ForumDiscussion>();
  private forumRefs = new Map<number, ForumDiscussionRef[]>();

  constructor(baseUrl: string, options: ClientOptions | string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const resolvedOptions: ClientOptions = typeof options === "string"
      ? { cookie: { name: "MoodleSession", value: options } }
      : options;
    this.fetchImpl = resolvedOptions.fetchImpl ?? fetch;
    this.cookie = resolvedOptions.cookie;
    this.sesskey = resolvedOptions.pageContext?.sesskey ?? null;
    this.userid = resolvedOptions.pageContext?.user_info.userid ?? null;
    this.userInfo = resolvedOptions.pageContext?.user_info ?? null;
    this.cacheOptions = resolvedOptions.cacheOptions;
    this.onLoginRequired = resolvedOptions.onLoginRequired;
  }

  async getSiteInfo(): Promise<UserInfo> {
    await this.ensureSession();
    const data = await this.call(FUNC_GET_SITE_INFO);
    if (!isRecord(data) || !("userid" in data)) {
      if (this.userInfo) {
        return this.userInfo;
      }
      throw new NotFoundError("Session appears invalid: could not retrieve user info");
    }
    const info = parseUserInfo(data);
    this.sesskey = typeof data.sesskey === "string" ? data.sesskey : this.sesskey;
    this.userid = info.userid;
    this.userInfo = info;
    await this.writeCache();
    return info;
  }

  async getCourses(): Promise<Course[]> {
    await this.ensureSession();
    try {
      const data = await this.call(FUNC_GET_COURSES, { userid: this.userid });
      return parseCourses(data);
    } catch (error) {
      if (!(error instanceof MoodleAPIError) || error.moodleErrorCode !== "servicenotavailable") {
        throw error;
      }
      return this.getCoursesTimeline();
    }
  }

  async resolveCourseReference(value: string): Promise<number> {
    const raw = value.trim();
    if (/^\d+$/.test(raw)) {
      return Number(raw);
    }
    const courses = await this.getCourses();
    const matches = courses.filter((course) => queryMatches(course.fullname, raw) || queryMatches(course.shortname, raw));
    if (matches.length === 1) {
      return matches[0].id;
    }
    if (!matches.length) {
      throw new NotFoundError(`Could not find a course matching '${raw}'. Run 'moodle courses' to inspect course IDs.`);
    }
    throw new NotFoundError(`Course '${raw}' is ambiguous. Matches: ${matches.slice(0, 5).map((course) => `${course.id}:${course.fullname || course.shortname}`).join(", ")}`);
  }

  async getCourseContents(courseId: number): Promise<Section[]> {
    await this.ensureSession();
    try {
      return parseCourseContents(await this.call(FUNC_GET_COURSE_CONTENTS, { courseid: courseId }));
    } catch (error) {
      if (!(error instanceof MoodleAPIError) || error.moodleErrorCode !== "servicenotavailable") {
        throw error;
      }
    }
    const response = await this.get(COURSE_PATH, { id: courseId });
    return this.scrapeCourseContents(courseId, response);
  }

  async getActivities(courseId: number): Promise<Section["activities"]> {
    return (await this.getCourseContents(courseId)).flatMap((section) => section.activities);
  }

  async getTodo(limit = 20, days?: number): Promise<TodoItem[]> {
    await this.ensureSession();
    const now = Math.floor(Date.now() / 1000);
    const data = await this.call(FUNC_GET_ACTION_EVENTS, {
      limitnum: limit,
      timesortfrom: now,
      timesortto: days ? now + days * 24 * 60 * 60 : 0,
      aftereventid: 0,
      limittononsuspendedevents: true,
    });
    const events = isRecord(data) && Array.isArray(data.events) ? data.events : [];
    return parseTodoItems(events);
  }

  async getAlerts(limit = 20): Promise<AlertSummary> {
    await this.ensureSession();
    const [notifications, counts, unread] = await this.callBatchValues([
      { methodname: FUNC_GET_POPUP_NOTIFICATIONS, args: { useridto: this.userid, limit, offset: 0 } },
      { methodname: FUNC_GET_CONVERSATION_COUNTS, args: { userid: this.userid } },
      { methodname: FUNC_GET_UNREAD_CONVERSATION_COUNTS, args: { userid: this.userid } },
    ]);
    return parseAlertSummary(notifications, counts, unread);
  }

  async getOverview(todoLimit = 5, todoDays?: number, alertsLimit = 5): Promise<Overview> {
    await this.ensureSession();
    const now = Math.floor(Date.now() / 1000);
    const results = await this.callBatch([
      { methodname: FUNC_GET_COURSES, args: { userid: this.userid } },
      {
        methodname: FUNC_GET_ACTION_EVENTS,
        args: {
          limitnum: todoLimit,
          timesortfrom: now,
          timesortto: todoDays ? now + todoDays * 24 * 60 * 60 : 0,
          aftereventid: 0,
          limittononsuspendedevents: true,
        },
      },
      { methodname: FUNC_GET_POPUP_NOTIFICATIONS, args: { useridto: this.userid, limit: alertsLimit, offset: 0 } },
      { methodname: FUNC_GET_CONVERSATION_COUNTS, args: { userid: this.userid } },
      { methodname: FUNC_GET_UNREAD_CONVERSATION_COUNTS, args: { userid: this.userid } },
    ]);
    const [coursesData, todoData, notifications, counts, unread] = results;
    const errors = results.flatMap((result, index) => {
      if (result.ok) {
        return [];
      }
      const labels = ["courses", "todo", "notifications", "conversation counts", "unread conversation counts"];
      return [`${labels[index]}: ${result.error.message}`];
    });
    const todoPayload = todoData?.ok ? todoData.data : {};
    return {
      user: this.userInfo!,
      courses: coursesData?.ok ? parseCourses(coursesData.data) : [],
      todo: parseTodoItems(isRecord(todoPayload) && Array.isArray(todoPayload.events) ? todoPayload.events : []),
      alerts:
        notifications?.ok && counts?.ok && unread?.ok
          ? parseAlertSummary(notifications.data, counts.data, unread.data)
          : undefined,
      errors,
    };
  }

  async getCourseGrades(courseId: number): Promise<CourseGrades> {
    await this.ensureSession();
    const courseHtml = await this.get(COURSE_PATH, { id: courseId });
    const candidates = [
      parseCourseGradesUrl(courseHtml, this.baseUrl),
      `${this.baseUrl}/course/user.php?mode=grade&id=${courseId}&user=${this.userid}`,
      `${this.baseUrl}${GRADE_REPORT_OVERVIEW_PATH}`,
      `${this.baseUrl}${GRADE_REPORT_INDEX_PATH}?id=${courseId}`,
      `${this.baseUrl}${GRADE_REPORT_PATH}?id=${courseId}`,
    ].filter(Boolean);
    const seen = new Set<string>();
    let overviewRows: Record<number, { course_name: string; grade: string; url: string }> = {};
    for (let index = 0; index < candidates.length; index += 1) {
      const url = candidates[index];
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      let html = "";
      try {
        html = await this.getAbsolute(url);
      } catch (error) {
        if (error instanceof MoodleAPIError && error.message.startsWith("HTTP 404")) {
          continue;
        }
        throw error;
      }
      if (hasCourseGradesHtml(html)) {
        return parseCourseGradesHtml(html, courseId, this.baseUrl);
      }
      overviewRows = parseGradeOverviewRows(html, this.baseUrl);
      const row = overviewRows[courseId];
      if (row) {
        if (row.url && !seen.has(row.url)) {
          candidates.push(row.url);
          continue;
        }
        return {
          course_id: courseId,
          course_name: row.course_name,
          learner_name: "",
          total_grade: row.grade,
          total_range: "",
          total_percentage: "",
          items: [],
        };
      }
    }
    return {
      course_id: courseId,
      course_name: "",
      learner_name: "",
      total_grade: "",
      total_range: "",
      total_percentage: "",
      items: [],
    };
  }

  async getAssignment(id: number): Promise<Assignment> {
    return parseAssignmentHtml(await this.get(ASSIGN_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getQuiz(id: number): Promise<Quiz> {
    return parseQuizHtml(await this.get(QUIZ_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getResource(id: number): Promise<Resource> {
    return parseResourceHtml(await this.get(RESOURCE_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getLink(id: number): Promise<Link> {
    return parseLinkHtml(await this.get(URL_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getPage(id: number): Promise<Page> {
    return parsePageHtml(await this.get(PAGE_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getFolder(id: number): Promise<Folder> {
    return parseFolderHtml(await this.get(FOLDER_VIEW_PATH, { id }), id, this.baseUrl);
  }

  async getForumDiscussion(discussionId: number): Promise<ForumDiscussion> {
    const cached = this.forumDiscussions.get(discussionId);
    if (cached) {
      return cached;
    }
    await this.ensureSession();
    try {
      const data = await this.call(FUNC_GET_DISCUSSION_POSTS, {
        discussionid: discussionId,
        sortby: "created",
        sortdirection: "ASC",
        includeinlineattachments: true,
      });
      const discussion = parseForumDiscussion(data, discussionId);
      if (discussion.group_id <= 0) {
        try {
          const html = await this.get(FORUM_DISCUSS_PATH, { d: discussionId });
          [discussion.group_id, discussion.group_name] = parseForumDiscussionGroupHtml(html);
        } catch {
          // Group metadata is best effort.
        }
      }
      this.forumDiscussions.set(discussionId, discussion);
      return discussion;
    } catch (error) {
      if (
        !(error instanceof MoodleAPIError) ||
        !["servicenotavailable", "accessexception"].includes(error.moodleErrorCode ?? "")
      ) {
        throw error;
      }
    }
    const discussion = parseForumDiscussionHtml(await this.get(FORUM_DISCUSS_PATH, { d: discussionId }), this.baseUrl, discussionId);
    this.forumDiscussions.set(discussionId, discussion);
    return discussion;
  }

  async getForumViewCmid(discussionId: number): Promise<number | null> {
    return parseForumViewCmidFromDiscussionHtml(await this.get(FORUM_DISCUSS_PATH, { d: discussionId }));
  }

  async resolveCourseIdForUrl(url: string): Promise<number | null> {
    return parseCourseIdFromPageHtml(await this.getAbsolute(url));
  }

  async getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]> {
    const cached = this.forumRefs.get(forumCmid);
    if (cached) {
      return cached;
    }
    const rootHtml = await this.get(FORUM_VIEW_PATH, { id: forumCmid });
    const groups = parseForumGroupsHtml(rootHtml);
    const refs = groups.length ? [] : parseForumDiscussionRefsHtml(rootHtml, this.baseUrl);
    const seen = new Set(refs.map((ref) => ref.id));
    for (const [groupId, groupName] of groups) {
      const html = await this.get(FORUM_VIEW_PATH, { id: forumCmid, group: groupId });
      for (const ref of parseForumDiscussionRefsHtml(html, this.baseUrl)) {
        if (seen.has(ref.id)) {
          continue;
        }
        ref.group_id = groupId;
        ref.group_name = groupName;
        seen.add(ref.id);
        refs.push(ref);
      }
    }
    this.forumRefs.set(forumCmid, refs);
    return refs;
  }

  async getCourseForums(courseId: number, courseName = ""): Promise<ForumActivityRef[]> {
    const sections = await this.getCourseContents(courseId);
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
      const courseName = (await this.getCourses()).find((course) => course.id === courseId);
      return this.getCourseForums(courseId, courseName?.fullname || courseName?.shortname || "");
    }
    const refs: ForumActivityRef[] = [];
    for (const course of await this.getCourses()) {
      refs.push(...(await this.getCourseForums(course.id, course.fullname || course.shortname)));
    }
    return refs;
  }

  async searchForumContent(options: {
    query: string;
    limit?: number;
    courseId?: number;
    forumCmid?: number;
    includePostText?: boolean;
    unreadOnly?: boolean;
    sortBy?: "relevance" | "recent";
    maxForums?: number;
    maxDiscussionsPerForum?: number;
  }): Promise<ForumSearchHit[]> {
    const query = options.query.trim();
    if (!query) {
      return [];
    }
    let forums = await this.getForums(options.courseId);
    if (options.forumCmid !== undefined) {
      forums = forums.filter((forum) => forum.id === options.forumCmid);
      if (!forums.length) {
        forums = [{ id: options.forumCmid, name: "", course_id: 0, course_name: "", url: `${this.baseUrl}${FORUM_VIEW_PATH}?id=${options.forumCmid}` }];
      }
    } else if (options.maxForums !== undefined) {
      forums = forums.slice(0, options.maxForums);
    }

    const hits: Array<[number, ForumSearchHit]> = [];
    const seen = new Set<string>();
    for (const forum of forums) {
      let refs = await this.getForumDiscussionRefs(forum.id);
      if (options.maxDiscussionsPerForum !== undefined) {
        refs = refs.slice(0, options.maxDiscussionsPerForum);
      }
      for (const ref of refs) {
        let discussion: ForumDiscussion | null = null;
        let latest = 0;
        let discussionHasUnread = false;
        if (options.includePostText !== false || options.unreadOnly || options.sortBy === "recent") {
          discussion = await this.getForumDiscussion(ref.id);
          latest = Math.max(0, ...discussion.posts.map((post) => post.time_created));
          discussionHasUnread = discussion.posts.some((post) => post.unread);
        }

        if (options.includePostText === false) {
          const score = matchScore(ref.subject, query);
          if (score > 0 && (!options.unreadOnly || discussionHasUnread)) {
            addHit(hits, seen, 400 + score, makeHit(forum, ref, { matched_in: "discussion_subject", snippet: snippetForText(ref.subject, query), unread: discussionHasUnread, time_created: latest }));
          }
          continue;
        }

        discussion ??= await this.getForumDiscussion(ref.id);
        let postMatched = false;
        for (const post of discussion.posts) {
          const subjectScore = matchScore(post.subject, query);
          const bodyScore = matchScore(post.message_text, query);
          if (subjectScore <= 0 && bodyScore <= 0) {
            continue;
          }
          if (options.unreadOnly && !post.unread) {
            continue;
          }
          postMatched = true;
          const matched_in = subjectScore >= bodyScore ? "post_subject" : "post_body";
          const matchedText = matched_in === "post_subject" ? post.subject : post.message_text;
          addHit(
            hits,
            seen,
            300 + Math.max(subjectScore, bodyScore),
            makeHit(forum, ref, {
              group_id: discussion.group_id || ref.group_id,
              group_name: discussion.group_name || ref.group_name,
              discussion_subject: discussion.subject || ref.subject,
              post_id: post.id,
              author_name: post.author.fullname,
              matched_in,
              snippet: snippetForText(matchedText, query),
              unread: post.unread,
              time_created: post.time_created,
              url: post.url || ref.url,
            }),
          );
        }
        if (!postMatched) {
          const score = matchScore(ref.subject, query);
          if (score > 0 && (!options.unreadOnly || discussionHasUnread)) {
            addHit(hits, seen, 400 + score, makeHit(forum, ref, { matched_in: "discussion_subject", snippet: snippetForText(ref.subject, query), unread: discussionHasUnread, time_created: latest }));
          }
        }
      }
    }

    hits.sort((a, b) => {
      if (options.sortBy === "recent") {
        return b[1].time_created - a[1].time_created || b[0] - a[0] || compareHit(a[1], b[1]);
      }
      return b[0] - a[0] || compareHit(a[1], b[1]);
    });
    return hits.slice(0, options.limit ?? 20).map(([, hit]) => hit);
  }

  async callBatch(requests: AjaxCall[]): Promise<AjaxBatchResult[]> {
    await this.ensureSession();
    return this.callBatchInternal(requests, true);
  }

  private async call(functionName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const [result] = await this.callBatchValues([{ methodname: functionName, args }]);
    return result;
  }

  private async callBatchValues(requests: AjaxCall[]): Promise<unknown[]> {
    const results = await this.callBatchInternal(requests, true);
    const failed = results.find((result) => !result.ok);
    if (failed && !failed.ok) {
      throw failed.error;
    }
    return results.map((result) => (result.ok ? result.data : undefined));
  }

  private async callBatchInternal(requests: AjaxCall[], allowRetry: boolean): Promise<AjaxBatchResult[]> {
    const payload = requests.map((request, index) => ({ index, methodname: request.methodname, args: request.args ?? {} }));
    const response = await this.fetchImpl(`${this.baseUrl}${AJAX_SERVICE_PATH}?sesskey=${encodeURIComponent(this.sesskey ?? "")}&info=${requests.map((request) => request.methodname).join(",")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${this.cookie.name}=${this.cookie.value}`,
      },
      body: JSON.stringify(payload),
    });
    if (response.url.includes("/login/") && this.onLoginRequired && allowRetry && !this.retryingLogin) {
      await this.reauthenticate();
      return this.callBatchInternal(requests, false);
    }
    const body = await response.json();
    const envelope = AjaxEnvelopeSchema.parse(body);
    const results: AjaxBatchResult[] = envelope.map((item) => {
      if (item.error) {
        return {
          ok: false,
          error: new MoodleAPIError(item.exception?.message ?? "Unknown API error", item.exception?.errorcode),
        };
      }
      return { ok: true, data: item.data ?? item };
    });
    if (
      allowRetry &&
      !this.retryingLogin &&
      this.onLoginRequired &&
      results.some((result) => !result.ok && isLoginRequiredError(result.error))
    ) {
      await this.reauthenticate();
      return this.callBatchInternal(requests, false);
    }
    return results;
  }

  private async ensureSession(): Promise<void> {
    if (this.sesskey && this.userid) {
      return;
    }
    const html = await this.get(DASHBOARD_PATH);
    const context = parsePageContext(html, this.baseUrl);
    this.applyContext(context);
    await this.writeCache();
  }

  private async get(pathname: string, params: Record<string, string | number> = {}): Promise<string> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    return this.getAbsolute(`${this.baseUrl}${pathname}${query ? `?${query}` : ""}`);
  }

  private async getAbsolute(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: { cookie: `${this.cookie.name}=${this.cookie.value}` }, redirect: "follow" });
    if (response.url.includes("/login/") && this.onLoginRequired && !this.retryingLogin) {
      await this.reauthenticate();
      return this.getAbsolute(url);
    }
    if (!response.ok) {
      throw new MoodleAPIError(`HTTP ${response.status} loading ${url}`);
    }
    return response.text();
  }

  private async getCoursesTimeline(): Promise<Course[]> {
    const courses: unknown[] = [];
    let offset = 0;
    while (true) {
      const data = await this.call(FUNC_GET_COURSES_BY_TIMELINE, { classification: "all", limit: 100, offset });
      if (!isRecord(data) || !Array.isArray(data.courses) || !data.courses.length) {
        break;
      }
      courses.push(...data.courses);
      const nextOffset = typeof data.nextoffset === "number" ? data.nextoffset : offset;
      if (nextOffset <= offset) {
        break;
      }
      offset = nextOffset;
    }
    return parseCourses(courses);
  }

  private async scrapeCourseContents(courseId: number, rootHtml: string): Promise<Section[]> {
    const pages = [rootHtml];
    for (const section of parseCourseSectionNumbers(rootHtml, courseId)) {
      if (section !== 0) {
        pages.push(await this.get(COURSE_PATH, { id: courseId, section }));
      }
    }
    const seen = new Set<number>();
    const sections: Section[] = [];
    for (const html of pages) {
      for (const section of parseCourseContentsHtml(html, this.baseUrl)) {
        const key = section.section || section.id;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        sections.push(section);
      }
    }
    return sections;
  }

  private async reauthenticate(): Promise<void> {
    if (!this.onLoginRequired) {
      throw new MoodleAPIError("Session expired", "servicerequireslogin");
    }
    this.retryingLogin = true;
    await deleteCachedSession(this.baseUrl, this.cacheOptions);
    try {
      const auth = await this.onLoginRequired();
      this.cookie = auth.cookie;
      this.applyContext(auth.pageContext);
      await this.writeCache();
    } finally {
      this.retryingLogin = false;
    }
  }

  private applyContext(context: PageContext): void {
    this.sesskey = context.sesskey;
    this.userid = context.user_info.userid;
    this.userInfo = context.user_info;
  }

  private async writeCache(): Promise<void> {
    if (this.cacheOptions && this.sesskey && this.userid) {
      try {
        await writeCachedSession({ baseUrl: this.baseUrl, cookieName: this.cookie.name, cookieValue: this.cookie.value, sesskey: this.sesskey, userid: this.userid, savedAt: (this.cacheOptions.now ?? Date.now)() }, this.cacheOptions);
      } catch {
        return;
      }
    }
  }
}

export async function createMoodleClient(
  baseUrl: string,
  options: AuthOptions & SessionCacheOptions & { noCache?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<MoodleClient> {
  const cacheOptions: SessionCacheOptions = { homeDir: options.homeDir, now: options.now, ttlMs: options.ttlMs };
  const authOptions = { ...options, fetch: options.fetch ?? options.fetchImpl };
  if (!options.noCache) {
    const cached = await readCachedSession(baseUrl, cacheOptions);
    if (cached) {
      return new MoodleClient(baseUrl, {
        fetchImpl: options.fetchImpl,
        cookie: { name: cached.cookieName, value: cached.cookieValue },
        pageContext: {
          sesskey: cached.sesskey,
          user_info: { userid: cached.userid, username: "", fullname: "", sitename: "", siteurl: baseUrl, lang: "" },
        },
        cacheOptions,
        onLoginRequired: async () => authToClientSession(await getAuthenticatedSession(baseUrl, authOptions)),
      });
    }
  }
  const auth = await getAuthenticatedSession(baseUrl, authOptions);
  const session = authToClientSession(auth);
  return new MoodleClient(baseUrl, {
    fetchImpl: options.fetchImpl,
    cookie: session.cookie,
    pageContext: session.pageContext,
    cacheOptions,
    onLoginRequired: async () => authToClientSession(await getAuthenticatedSession(baseUrl, authOptions)),
  });
}

function authToClientSession(auth: AuthenticatedSession): { cookie: MoodleSessionCookie; pageContext: PageContext } {
  return {
    cookie: auth.cookie,
    pageContext: {
      sesskey: auth.sesskey,
      user_info: {
        userid: auth.userid,
        username: "",
        fullname: "",
        sitename: "",
        siteurl: auth.baseUrl,
        lang: "",
      },
    },
  };
}

export function filterDiscussionToPost(discussion: ForumDiscussion, postId: number | null): ForumDiscussion {
  if (postId === null) {
    return discussion;
  }
  const posts = discussion.posts.filter((post) => post.id === postId);
  if (!posts.length) {
    throw new NotFoundError(`Post ${postId} was not found in discussion ${discussion.id}.`);
  }
  return { ...discussion, posts };
}

function queryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase().split(/\s+/).join(" ");
  const needle = query.toLowerCase().split(/\s+/).join(" ");
  return needle ? haystack.includes(needle) || needle.split(" ").every((token) => haystack.includes(token)) : true;
}

function matchScore(text: string, query: string): number {
  const haystack = text.toLowerCase().split(/\s+/).join(" ");
  const normalized = query.toLowerCase().split(/\s+/).join(" ");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!haystack || !normalized) {
    return 0;
  }
  if (haystack.includes(normalized)) {
    return 100 + normalized.length;
  }
  if (tokens.length && tokens.every((token) => haystack.includes(token))) {
    return 60 + tokens.length;
  }
  return 0;
}

function snippetForText(text: string, query: string, maxLen = 120): string {
  const cleaned = text.split(/\s+/).join(" ").trim();
  if (!cleaned || cleaned.length <= maxLen) {
    return cleaned;
  }
  const normalized = query.toLowerCase().split(/\s+/).join(" ");
  const lower = cleaned.toLowerCase();
  let start = lower.indexOf(normalized);
  if (start < 0) {
    start = normalized.split(/\s+/).map((token) => lower.indexOf(token)).find((index) => index >= 0) ?? -1;
  }
  if (start < 0) {
    return `${cleaned.slice(0, maxLen - 1)}...`;
  }
  const left = Math.max(0, start - Math.floor(maxLen / 2));
  const right = Math.min(cleaned.length, left + maxLen);
  return `${left > 0 ? "..." : ""}${cleaned.slice(left, right)}${right < cleaned.length ? "..." : ""}`;
}

function makeHit(forum: ForumActivityRef, ref: ForumDiscussionRef, override: Partial<ForumSearchHit>): ForumSearchHit {
  return {
    course_id: forum.course_id,
    course_name: forum.course_name,
    forum_id: forum.id,
    forum_name: forum.name,
    group_id: ref.group_id,
    group_name: ref.group_name,
    discussion_id: ref.id,
    discussion_subject: ref.subject,
    post_id: 0,
    author_name: "",
    matched_in: "",
    snippet: "",
    unread: false,
    time_created: 0,
    url: ref.url,
    ...override,
  };
}

function addHit(hits: Array<[number, ForumSearchHit]>, seen: Set<string>, score: number, hit: ForumSearchHit): void {
  const key = `${hit.discussion_id}:${hit.post_id}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  hits.push([score, hit]);
}

function compareHit(a: ForumSearchHit, b: ForumSearchHit): number {
  return a.course_name.localeCompare(b.course_name) || a.forum_name.localeCompare(b.forum_name) || a.discussion_id - b.discussion_id || a.post_id - b.post_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
