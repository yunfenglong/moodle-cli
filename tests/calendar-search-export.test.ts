import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MoodleClient } from "../src/client";
import { searchCourseContent } from "../src/course-search";
import { planDownloads } from "../src/download";
import { exportCourse } from "../src/export";
import { eventsToIcs } from "../src/ics";

const BASE_URL = "https://school.example.edu";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

interface SeenRequest {
  url: string;
  init?: RequestInit;
}

function installFetch(routes: Array<(request: SeenRequest) => Response | undefined>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { url: String(input), init };
    for (const route of routes) {
      const response = route(request);
      if (response) {
        return response;
      }
    }
    throw new Error(`Unexpected fetch: ${request.url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
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

function contentsRoute(courseId: number, data: unknown): (request: SeenRequest) => Response | undefined {
  return (request) => {
    if (request.init?.method === "POST" && request.url.includes("core_course_get_contents")) {
      const payload = JSON.parse(String(request.init.body)) as Array<{ args?: { courseid?: number } }>;
      if (payload[0]?.args?.courseid === courseId) {
        return jsonResponse([{ index: 0, error: false, data }]);
      }
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

describe("calendar", () => {
  it("loads and sorts upcoming events", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_calendar_get_calendar_upcoming_view", {
        events: [
          { id: 2, name: "Quiz closes", timestart: 1760000000, timeduration: 0, course: { id: 101, fullname: "Mathematics 101" }, modulename: "quiz", eventtype: "close", url: `${BASE_URL}/mod/quiz/view.php?id=9` },
          { id: 1, name: "Essay due", description: "<p>Submit online</p>", timestart: 1750000000, timeduration: 3600, course: { id: 101, fullname: "Mathematics 101" }, modulename: "assign", eventtype: "due", url: `${BASE_URL}/mod/assign/view.php?id=31` },
        ],
      }),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const events = await client.getCalendarUpcoming();

    expect(events.map((event) => event.name)).toEqual(["Essay due", "Quiz closes"]);
    expect(events[0]).toMatchObject({ description: "Submit online", ends_at: 1750003600, course_name: "Mathematics 101" });
  });

  it("flattens and dedupes monthly view events", async () => {
    const event = { id: 5, name: "Lecture", timestart: 1750000000, timeduration: 0, course: { id: 101, fullname: "Mathematics 101" }, eventtype: "course" };
    installFetch([
      dashboardRoute,
      ajaxRoute("core_calendar_get_calendar_monthly_view", {
        weeks: [
          { days: [{ events: [event] }, { events: [] }] },
          { days: [{ events: [event, { id: 6, name: "Workshop", timestart: 1750100000, timeduration: 0, eventtype: "course" }] }] },
        ],
      }),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const events = await client.getCalendarMonth(2026, 7);

    expect(events.map((item) => item.name)).toEqual(["Lecture", "Workshop"]);
  });

  it("renders events as ICS with escaping", () => {
    const ics = eventsToIcs(
      [{
        id: 1,
        name: "Essay, part 1",
        description: "Line one\nLine two",
        course_id: 101,
        course_name: "Mathematics 101",
        modname: "assign",
        event_type: "due",
        starts_at: 1750000000,
        ends_at: 1750003600,
        location: "",
        url: `${BASE_URL}/mod/assign/view.php?id=31`,
      }],
      new Date(1750000000000),
    );

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:moodle-event-1@moodle-cli");
    expect(ics).toContain("SUMMARY:Essay\\, part 1 (Mathematics 101)");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(ics).toContain(`DTSTART:${new Date(1750000000000).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`);
    expect(ics).toContain("END:VCALENDAR");
  });
});

describe("course search", () => {
  it("searches activity names and descriptions across all courses", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_enrol_get_users_courses", JSON.parse(fixture("courses.json"))),
      contentsRoute(101, [{
        id: 10, name: "Week 1", section: 1, visible: 1, summary: "",
        modules: [
          { id: 55, name: "Integration slides", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=55`, visible: 1, description: "" },
          { id: 66, name: "Notes", modname: "page", url: `${BASE_URL}/mod/page/view.php?id=66`, visible: 1, description: "<p>Covers integration by parts</p>" },
        ],
      }]),
      contentsRoute(202, [{
        id: 20, name: "Intro", section: 1, visible: 1, summary: "",
        modules: [{ id: 77, name: "Course outline", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=77`, visible: 1, description: "" }],
      }]),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const hits = await searchCourseContent(client, "integration");

    expect(hits.map((hit) => [hit.activity_name, hit.matched_in])).toEqual([
      ["Integration slides", "name"],
      ["Notes", "description"],
    ]);
    expect(hits[0].course_name).toBe("Mathematics 101");
  });
});

describe("assignment submission files", () => {
  const assignHtml = `
    <html><h1>Essay 1</h1>
    <table class="generaltable">
      <tr><th>Submission status</th><td>Submitted for grading</td></tr>
      <tr><th>File submissions</th><td><a href="${BASE_URL}/pluginfile.php/9/essay.pdf">essay.pdf</a></td></tr>
    </table></html>`;

  it("exposes submitted files on assignment detail and plans downloads from an assign URL", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(assignHtml) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const assignment = await client.getAssignment(31);
    expect(assignment.submission_files).toEqual(["essay.pdf"]);

    const plans = await planDownloads(client, `${BASE_URL}/mod/assign/view.php?id=31`);
    expect(plans).toEqual([{ name: "essay.pdf", url: `${BASE_URL}/pluginfile.php/9/essay.pdf`, source: "assign:31" }]);
  });
});

describe("course export", () => {
  it("exports pages, links, and files into a course directory", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_enrol_get_users_courses", JSON.parse(fixture("courses.json"))),
      contentsRoute(101, [{
        id: 10, name: "Week 1", section: 1, visible: 1, summary: "Getting started",
        modules: [
          { id: 55, name: "Slides", modname: "resource", url: `${BASE_URL}/mod/resource/view.php?id=55`, visible: 1, description: "" },
          { id: 66, name: "Intro Page", modname: "page", url: `${BASE_URL}/mod/page/view.php?id=66`, visible: 1, description: "" },
          { id: 88, name: "Course site", modname: "url", url: `${BASE_URL}/mod/url/view.php?id=88`, visible: 1, description: "" },
        ],
      }]),
      (request) => request.url === `${BASE_URL}/mod/resource/view.php?id=55` ? htmlResponse(fixture("resource.html")) : undefined,
      (request) => request.url === `${BASE_URL}/mod/page/view.php?id=66` ? htmlResponse(fixture("page.html")) : undefined,
      (request) => request.url === `${BASE_URL}/mod/url/view.php?id=88` ? htmlResponse(fixture("link.html")) : undefined,
      (request) => request.url === `${BASE_URL}/pluginfile.php/1/slides.pdf`
        ? new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="slides.pdf"' } })
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");
    const dir = await mkdtemp(join(tmpdir(), "moodle-export-"));

    const summary = await exportCourse(client, 101, { dir });

    expect(summary.course_name).toBe("Mathematics 101");
    expect(summary.sections).toBe(1);
    expect(summary.links).toBe(1);
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0].status).toBe("downloaded");
    const readme = readFileSync(join(summary.dir, "README.md"), "utf8");
    expect(readme).toContain("# Mathematics 101");
    expect(readme).toContain("## Week 1");
    expect(readme).toContain("- [file] Slides");
    expect(existsSync(join(summary.dir, "00 Week 1", "slides.pdf"))).toBe(true);
  });
});
