import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MoodleAPIError, MoodleClient, type AjaxCall } from "../src/client";
import { resolveCourseReference, parseActivityReference, resolveTopLevelUrl } from "../src/url-resolver";

const BASE_URL = "https://school.example.edu";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name));
}

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function installFetch(routes: Array<(request: SeenRequest) => Response | undefined>) {
  const seen: SeenRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    seen.push(request);
    for (const route of routes) {
      const response = route(request);
      if (response) {
        return response;
      }
    }
    throw new Error(`Unexpected fetch: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

function dashboardRoute(request: SeenRequest): Response | undefined {
  if (request.url === `${BASE_URL}/my/`) {
    return htmlResponse(fixture("dashboard.html"));
  }
  return undefined;
}

function ajaxRoute(methodname: string, data: unknown): (request: SeenRequest) => Response | undefined {
  return (request) => {
    const url = new URL(request.url);
    if (request.init?.method === "POST" && url.pathname === "/lib/ajax/service.php" && url.searchParams.get("info")?.includes(methodname)) {
      return jsonResponse([{ index: 0, error: false, data }]);
    }
    return undefined;
  };
}

function ajaxErrorRoute(methodname: string, errorcode = "servicenotavailable"): (request: SeenRequest) => Response | undefined {
  return (request) => {
    const url = new URL(request.url);
    if (request.init?.method === "POST" && url.pathname === "/lib/ajax/service.php" && url.searchParams.get("info")?.includes(methodname)) {
      return jsonResponse([{ index: 0, error: true, exception: { message: "Web service is not available", errorcode } }]);
    }
    return undefined;
  };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("MoodleClient course/activity modules", () => {
  it("loads courses through the primary AJAX function and resolves course references", async () => {
    installFetch([dashboardRoute, ajaxRoute("core_enrol_get_users_courses", jsonFixture("courses.json"))]);
    const client = new MoodleClient(BASE_URL, "session");

    const courses = await client.getCourses();

    expect(courses).toEqual([
      { id: 101, shortname: "MATH101", fullname: "Mathematics 101", category: 4, visible: true, startdate: 1700000000 },
      { id: 202, shortname: "MATH102", fullname: "Mathematics 102", category: 4, visible: false, startdate: 1700000100 },
    ]);
    expect(resolveCourseReference("101", courses)).toBe(101);
    expect(resolveCourseReference("102", courses)).toBe(102);
    expect(resolveCourseReference("MATH101", courses)).toBe(101);
    expect(() => resolveCourseReference("Mathematics", courses)).toThrow(/ambiguous/i);
    expect(() => resolveCourseReference("Physics", courses)).toThrow(/Could not find/);
  });

  it("falls back to the timeline courses API when the primary course API is unavailable", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_enrol_get_users_courses"),
      (request) => {
        if (request.init?.method !== "POST" || !request.url.includes("core_course_get_enrolled_courses_by_timeline_classification")) {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        const offset = body[0]?.args?.offset;
        return jsonResponse([
          {
            index: 0,
            error: false,
            data: offset === 0 ? { courses: jsonFixture("courses.json"), nextoffset: 100 } : { courses: [], nextoffset: 100 },
          },
        ]);
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const courses = await client.getCourses();

    expect(courses).toHaveLength(2);
    expect(seen.filter((request) => request.init?.method === "POST")).toHaveLength(3);
  });

  it("loads course contents through AJAX and exposes a flattened activity list", async () => {
    installFetch([dashboardRoute, ajaxRoute("core_course_get_contents", jsonFixture("course-contents.json"))]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);
    const activities = await client.getActivities(101);

    expect(sections[0].activities).toHaveLength(2);
    expect(activities.map((activity) => activity.name)).toEqual(["Syllabus", "Quiz 1"]);
  });

  it("scrapes course contents when the course contents AJAX function is unavailable", async () => {
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("core_course_get_contents"),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101` ? htmlResponse(fixture("course-page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101&section=1` ? htmlResponse(fixture("course-section-1.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const sections = await client.getCourseContents(101);

    expect(sections).toEqual([
      { id: 10, name: "General", section: 0, visible: true, summary: "General resources", activities: [] },
      {
        id: 11,
        name: "Week 1",
        section: 1,
        visible: true,
        summary: "Start here",
        activities: [
          {
            id: 21,
            name: "Syllabus",
            modname: "resource",
            url: "https://school.example.edu/mod/resource/view.php?id=21",
            visible: true,
            description: "Read first",
          },
          {
            id: 22,
            name: "Quiz 1",
            modname: "quiz",
            url: "https://school.example.edu/mod/quiz/view.php?id=22",
            visible: false,
            description: "",
          },
        ],
      },
    ]);
  });

  it("uses one batched AJAX POST for overview and preserves per-entry errors", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      (request) => {
        if (request.init?.method !== "POST") {
          return undefined;
        }
        const body = JSON.parse(String(request.init.body)) as AjaxCall[];
        if (body.map((call) => call.methodname).join(",") === "ok_method,bad_method") {
          return jsonResponse([
            { index: 0, error: false, data: { ok: true } },
            { index: 1, error: true, exception: { message: "Bad method", errorcode: "servicenotavailable" } },
          ]);
        }
        expect(body.map((call) => call.methodname)).toEqual([
          "core_enrol_get_users_courses",
          "core_calendar_get_action_events_by_timesort",
          "message_popup_get_popup_notifications",
          "core_message_get_conversation_counts",
          "core_message_get_unread_conversation_counts",
        ]);
        return jsonResponse([
          { index: 0, error: false, data: jsonFixture("courses.json") },
          {
            index: 1,
            error: false,
            data: {
              events: [
                {
                  id: 301,
                  name: "Quiz 1 is due",
                  activityname: "Quiz 1",
                  modulename: "quiz",
                  course: { id: 101, fullname: "Mathematics 101", progress: 42 },
                  timesort: 1760000000,
                  action: { actionable: true, name: "Attempt quiz", url: `${BASE_URL}/mod/quiz/view.php?id=22` },
                  url: `${BASE_URL}/mod/quiz/view.php?id=22`,
                  eventtype: "due",
                },
              ],
            },
          },
          { index: 2, error: true, exception: { message: "Notifications disabled", errorcode: "servicenotavailable" } },
          { index: 3, error: false, data: { favourites: 1, types: { "1": 2 } } },
          { index: 4, error: false, data: { favourites: 0, types: { "1": 1 } } },
        ]);
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const overview = await client.getOverview();

    expect(seen.filter((request) => request.init?.method === "POST")).toHaveLength(1);
    expect(overview.courses).toHaveLength(2);
    expect(overview.todo).toHaveLength(1);
    expect(overview.errors).toEqual(["notifications: Notifications disabled"]);

    const results = await client.callBatch([
      { methodname: "ok_method", args: {} },
      { methodname: "bad_method", args: {} },
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(MoodleAPIError);
    }
  });

  it("scrapes grades and returns an empty grade report when no grade page is usable", async () => {
    installFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/course/view.php?id=101` ? htmlResponse(fixture("course-page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/grade/report/user/index.php?id=101` ? htmlResponse(fixture("grades.html")) : undefined),
      (request) => (request.url.includes("/grade/") || request.url.includes("/course/user.php") ? htmlResponse("<html></html>", 404) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const grades = await client.getCourseGrades(101);

    expect(grades.course_name).toBe("Mathematics 101");
    expect(grades.total_grade).toBe("73.00");
    expect(grades.items[0]).toMatchObject({ name: "Quiz 1", grade: "8.00", feedback: "Good" });

    installFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/course/view.php?id=404` ? htmlResponse("<html><h1>No Grades</h1></html>") : undefined),
      (request) => (request.url.includes("/grade/") || request.url.includes("/course/user.php") ? htmlResponse("<html></html>", 404) : undefined),
    ]);
    const empty = await new MoodleClient(BASE_URL, "session").getCourseGrades(404);
    expect(empty).toMatchObject({ course_id: 404, items: [] });
  });

  it("scrapes six activity detail pages and parses activity references", async () => {
    installFetch([
      dashboardRoute,
      (request) => (request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(fixture("assign.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/quiz/view.php?id=32` ? htmlResponse(fixture("quiz.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/resource/view.php?id=33` ? htmlResponse(fixture("resource.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/url/view.php?id=34` ? htmlResponse(fixture("link.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(fixture("page.html")) : undefined),
      (request) => (request.url === `${BASE_URL}/mod/folder/view.php?id=36` ? htmlResponse(fixture("folder.html")) : undefined),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.getAssignment(31)).resolves.toMatchObject({ name: "Essay 1", due_pretty: "Friday, 10 May 2026, 5:00 PM" });
    await expect(client.getQuiz(32)).resolves.toMatchObject({ name: "Quiz 1", attempts_allowed: "2" });
    await expect(client.getResource(33)).resolves.toMatchObject({ target_name: "slides.pdf" });
    await expect(client.getLink(34)).resolves.toMatchObject({ target_url: "https://example.com/reading" });
    await expect(client.getPage(35)).resolves.toMatchObject({ content_text: "Remember the integration rules." });
    await expect(client.getFolder(36)).resolves.toMatchObject({ files: ["chapter-1.pdf", "chapter-2.pdf"] });

    expect(parseActivityReference(`${BASE_URL}/mod/assign/view.php?id=31`, { label: "Assignment", path: "/mod/assign/view.php" })).toBe(31);
    expect(parseActivityReference("32", { label: "Quiz", path: "/mod/quiz/view.php" })).toBe(32);
  });

  it("resolves top-level Moodle URLs and rejects unsupported paths", () => {
    expect(resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/mod/assign/view.php?id=31` })).toEqual({
      commandName: "assign",
      kwargs: { assign: "31", asJson: false, asYaml: false },
    });
    expect(resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/course/view.php?id=101` })).toEqual({
      commandName: "course",
      kwargs: { course: "101", asJson: false, asYaml: false },
    });
    expect(() => resolveTopLevelUrl({ baseUrl: BASE_URL, target: `${BASE_URL}/calendar/view.php?view=month` })).toThrow(
      /Unsupported Moodle URL/,
    );
  });
});
