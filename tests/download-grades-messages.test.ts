import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MoodleClient } from "../src/client";
import { executeDownloads, planDownloads } from "../src/download";

const BASE_URL = "https://school.example.edu";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
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

describe("grades overview", () => {
  it("loads the overview through the gradereport AJAX function and joins course names", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("gradereport_overview_get_course_grades", { grades: [{ courseid: 101, grade: "82.50 %" }, { courseid: 202, grade: "-" }] }),
      ajaxRoute("core_enrol_get_users_courses", JSON.parse(fixture("courses.json"))),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const rows = await client.getGradesOverview();

    expect(rows).toEqual([
      { course_id: 101, course_name: "Mathematics 101", grade: "82.50 %", url: `${BASE_URL}/course/user.php?mode=grade&id=101` },
      { course_id: 202, course_name: "Mathematics 102", grade: "-", url: `${BASE_URL}/course/user.php?mode=grade&id=202` },
    ]);
  });

  it("falls back to scraping the overview report when the AJAX function is disabled", async () => {
    const overviewHtml = `
      <table id="overview-grade">
        <tbody>
          <tr><td><a href="/course/user.php?mode=grade&id=101">Mathematics 101</a></td><td>82.50 %</td></tr>
        </tbody>
      </table>`;
    installFetch([
      dashboardRoute,
      ajaxErrorRoute("gradereport_overview_get_course_grades"),
      (request) => request.url.startsWith(`${BASE_URL}/grade/report/overview/index.php`) ? htmlResponse(overviewHtml) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const rows = await client.getGradesOverview();

    expect(rows).toEqual([
      { course_id: 101, course_name: "Mathematics 101", grade: "82.50 %", url: `${BASE_URL}/course/user.php?mode=grade&id=101` },
    ]);
  });
});

describe("messages", () => {
  it("lists conversations with the other member's name and last message preview", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_message_get_conversations", {
        conversations: [{
          id: 33,
          name: "",
          type: 1,
          membercount: 2,
          unreadcount: 2,
          isfavourite: false,
          members: [{ id: 12, fullname: "Alice Example" }, { id: 7, fullname: "Me Myself" }],
          messages: [{ id: 900, useridfrom: 12, text: "<p>See you at the lab</p>", timecreated: 1750000000 }],
        }],
      }),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const conversations = await client.getConversations();

    expect(conversations).toEqual([{
      id: 33,
      name: "Alice Example",
      type: "direct",
      member_count: 2,
      unread_count: 2,
      is_favourite: false,
      last_message: "See you at the lab",
      last_message_at: 1750000000,
      last_sender: "Alice Example",
    }]);
  });

  it("shows conversation messages in chronological order with sender names", async () => {
    installFetch([
      dashboardRoute,
      ajaxRoute("core_message_get_conversation_messages", {
        id: 33,
        members: [{ id: 12, fullname: "Alice Example" }],
        messages: [
          { id: 902, useridfrom: 7, text: "<p>On my way</p>", timecreated: 1750000100 },
          { id: 900, useridfrom: 12, text: "<p>See you at the lab</p>", timecreated: 1750000000 },
        ],
      }),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const detail = await client.getConversationMessages(33);

    expect(detail.name).toBe("Alice Example");
    expect(detail.messages.map((message) => [message.sender_name, message.text])).toEqual([
      ["Alice Example", "See you at the lab"],
      ["me", "On my way"],
    ]);
  });
});

describe("download", () => {
  it("downloads a Page body and its plugin files from a Page URL", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(fixture("page-files.html")) : undefined,
      (request) => request.url === `${BASE_URL}/pluginfile.php/10/mod_page/content/35/handout.pdf?forcedownload=1`
        ? new Response("handout", { headers: { "Content-Type": "application/pdf" } })
        : undefined,
      (request) => request.url === `${BASE_URL}/pluginfile.php/10/mod_page/content/35/diagram.png`
        ? new Response("diagram", { headers: { "Content-Type": "image/png" } })
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");
    const dir = await mkdtemp(join(tmpdir(), "moodle-download-"));

    const page = await client.getPage(35);
    expect(page.links).toEqual([
      { text: "handout", url: `${BASE_URL}/pluginfile.php/10/mod_page/content/35/handout.pdf?forcedownload=1` },
      { text: "external reference", url: "https://example.com/reference" },
    ]);
    expect(page.image_urls).toEqual([`${BASE_URL}/pluginfile.php/10/mod_page/content/35/diagram.png`]);
    expect(page.files.map((file) => file.name)).toEqual(["handout.pdf", "diagram.png"]);
    expect(page.content_html).toContain("<p>Read the");
    expect(page.tables).toEqual([]);

    const plans = await planDownloads(client, `${BASE_URL}/mod/page/view.php?id=35`);
    const results = await executeDownloads(client, plans, { dir });

    expect(results.every((result) => result.status === "downloaded")).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["Week Notes.assets", "Week Notes.md"]);
    expect(readdirSync(join(dir, "Week Notes.assets")).sort()).toEqual(["diagram.png", "handout.pdf"]);
    const markdown = readFileSync(join(dir, "Week Notes.md"), "utf8");
    expect(markdown).toContain("[handout](Week Notes.assets/handout.pdf)");
    expect(markdown).toContain("[external reference](https://example.com/reference)");
    expect(markdown).toContain("Week Notes.assets/diagram.png");
    expect(markdown).not.toContain(`${BASE_URL}/pluginfile.php`);
  });

  it("accepts only a Page course-module ID", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/resource/view.php?id=35` ? htmlResponse("Incorrect course module", 404) : undefined,
      (request) => request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(fixture("page-files.html")) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const plans = await planDownloads(client, "35");

    expect(plans[0]).toMatchObject({
      name: "Week Notes.md",
      source: "page:35:content",
    });
  });

  it("deduplicates Page plugin files and gives colliding filenames stable suffixes", async () => {
    const pageHtml = `
      <html><h1>Collisions</h1><div class="box generalbox">
        <a href="/pluginfile.php/10/mod_page/content/35/one/notes.pdf?forcedownload=1">notes.pdf</a>
        <img src="/pluginfile.php/10/mod_page/content/35/one/notes.pdf" alt="same file">
        <a href="/pluginfile.php/10/mod_page/content/35/two/notes.pdf">notes.pdf</a>
      </div></html>`;
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(pageHtml) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const page = await client.getPage(35);
    const plans = await planDownloads(client, `${BASE_URL}/mod/page/view.php?id=35`);

    expect(page.files).toHaveLength(2);
    expect(page.image_urls).toEqual([`${BASE_URL}/pluginfile.php/10/mod_page/content/35/one/notes.pdf`]);
    expect(plans.slice(1).map((plan) => plan.relative_path)).toEqual([
      "Collisions.assets/notes.pdf",
      "Collisions.assets/notes (2).pdf",
    ]);
  });

  it("does not save an HTML error returned for a Page attachment", async () => {
    const pageHtml = `
      <html><h1>Broken attachment</h1><div class="box generalbox">
        <a href="/pluginfile.php/10/mod_page/content/35/handout.pdf">handout.pdf</a>
      </div></html>`;
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/page/view.php?id=35` ? htmlResponse(pageHtml) : undefined,
      (request) => request.url === `${BASE_URL}/pluginfile.php/10/mod_page/content/35/handout.pdf`
        ? htmlResponse("<html><h1>Access denied</h1></html>")
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");
    const dir = await mkdtemp(join(tmpdir(), "moodle-download-"));

    const plans = await planDownloads(client, `${BASE_URL}/mod/page/view.php?id=35`);
    const results = await executeDownloads(client, plans, { dir });

    expect(results.map((result) => result.status)).toEqual(["downloaded", "failed"]);
    expect(results[1].error).toMatch(/HTML page/);
    expect(existsSync(join(dir, "Broken attachment.assets", "handout.pdf"))).toBe(false);
  });

  it("reauthenticates and retries when a Page attachment redirects to login", async () => {
    const pageHtml = `
      <html><h1>Session retry</h1><div class="box generalbox">
        <a href="/pluginfile.php/10/mod_page/content/35/handout.pdf">handout.pdf</a>
      </div></html>`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE_URL}/mod/page/view.php?id=35`) {
        return htmlResponse(pageHtml);
      }
      if (url === `${BASE_URL}/pluginfile.php/10/mod_page/content/35/handout.pdf`) {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie === "MoodleSession=old-session") {
          const login = htmlResponse("<html>Log in</html>");
          Object.defineProperty(login, "url", { value: `${BASE_URL}/login/index.php` });
          return login;
        }
        return new Response("handout", { headers: { "Content-Type": "application/pdf" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const cacheHome = await mkdtemp(join(tmpdir(), "moodle-cache-"));
    const onLoginRequired = vi.fn(async () => ({
      cookie: { name: "MoodleSession", value: "new-session" },
      pageContext: {
        sesskey: "new-sesskey",
        user_info: { userid: 7, username: "alice", fullname: "Alice", sitename: "School", siteurl: BASE_URL },
      },
    }));
    const client = new MoodleClient(BASE_URL, {
      fetchImpl: fetchImpl as typeof fetch,
      cookie: { name: "MoodleSession", value: "old-session" },
      pageContext: {
        sesskey: "old-sesskey",
        user_info: { userid: 7, username: "alice", fullname: "Alice", sitename: "School", siteurl: BASE_URL },
      },
      cacheOptions: { homeDir: cacheHome },
      onLoginRequired,
    });
    const dir = await mkdtemp(join(tmpdir(), "moodle-download-"));

    const plans = await planDownloads(client, `${BASE_URL}/mod/page/view.php?id=35`);
    const results = await executeDownloads(client, plans, { dir });

    expect(onLoginRequired).toHaveBeenCalledOnce();
    expect(results.map((result) => result.status)).toEqual(["downloaded", "downloaded"]);
    expect(readFileSync(join(dir, "Session retry.assets", "handout.pdf"), "utf8")).toBe("handout");
  });

  it("downloads a resource file into the destination directory", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/resource/view.php?id=55` ? htmlResponse(fixture("resource.html")) : undefined,
      (request) => request.url === `${BASE_URL}/pluginfile.php/1/slides.pdf`
        ? new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="slides.pdf"' },
          })
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");
    const dir = await mkdtemp(join(tmpdir(), "moodle-download-"));

    const plans = await planDownloads(client, "55");
    const results = await executeDownloads(client, plans, { dir });

    expect(results).toEqual([{
      name: "slides.pdf",
      file: join(dir, "slides.pdf"),
      url: `${BASE_URL}/pluginfile.php/1/slides.pdf`,
      bytes: 4,
      status: "downloaded",
    }]);
    expect(readdirSync(dir)).toEqual(["slides.pdf"]);

    const again = await executeDownloads(client, plans, { dir });
    expect(again[0].status).toBe("exists");
  });

  it("plans folder downloads from a folder URL and supports dry-run", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/folder/view.php?id=77` ? htmlResponse(fixture("folder.html")) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const plans = await planDownloads(client, `${BASE_URL}/mod/folder/view.php?id=77`);
    const results = await executeDownloads(client, plans, { dir: ".", dryRun: true });

    expect(plans.map((plan) => plan.url)).toEqual([
      `${BASE_URL}/pluginfile.php/a.pdf`,
      `${BASE_URL}/pluginfile.php/b.pdf`,
    ]);
    expect(results.every((result) => result.status === "planned")).toBe(true);
  });

  it("marks HTML responses as failures instead of saving them", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/resource/view.php?id=99` ? htmlResponse("<html><h1>Embedded</h1></html>") : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");
    const dir = await mkdtemp(join(tmpdir(), "moodle-download-"));

    const plans = await planDownloads(client, "99");
    const results = await executeDownloads(client, plans, { dir });

    expect(results[0].status).toBe("failed");
    expect(results[0].error).toMatch(/HTML page/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
