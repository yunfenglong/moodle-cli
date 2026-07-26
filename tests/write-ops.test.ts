import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { submitAssignment } from "../src/assign-submit";
import { getChoice, voteChoice } from "../src/choice";
import { MoodleClient } from "../src/client";
import { completeFeedback, getFeedback } from "../src/feedback";

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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const EDIT_SUBMISSION_HTML = `
<html><h1>Essay 1</h1>
<script>M.cfg = {"contextid":901,"sesskey":"sesskey123"};</script>
<script>M.form_filemanager.init(Y, {"repositories":{"4":{"id":4,"type":"upload","name":"Upload a file"}}});</script>
<form method="post" action="${BASE_URL}/mod/assign/view.php" class="mform">
<input type="hidden" name="id" value="31">
<input type="hidden" name="userid" value="7">
<input type="hidden" name="action" value="savesubmission">
<input type="hidden" name="sesskey" value="sesskey123">
<input type="hidden" name="files_filemanager" value="654321">
</form></html>`;

const CONFIRM_SUBMIT_HTML = `
<html><form method="post" action="${BASE_URL}/mod/assign/view.php">
<input type="hidden" name="id" value="31">
<input type="hidden" name="action" value="confirmsubmit">
<input type="hidden" name="sesskey" value="sesskey123">
<div><input type="checkbox" name="submissionstatement" id="ss">This assignment is my own work.</div>
</form></html>`;

const SUBMITTED_VIEW_HTML = `
<html><h1>Essay 1</h1>
<table class="generaltable">
<tr><th>Submission status</th><td>Submitted for grading</td></tr>
</table></html>`;

describe("assignment submission", () => {
  it("uploads files, saves the submission, and submits for grading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moodle-submit-"));
    const filePath = join(dir, "essay.pdf");
    await writeFile(filePath, "PDF!");

    const { seen } = installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31&action=editsubmission` ? htmlResponse(EDIT_SUBMISSION_HTML) : undefined,
      (request) => request.url.startsWith(`${BASE_URL}/repository/draftfiles_ajax.php`) ? jsonResponse({}) : undefined,
      (request) => request.url === `${BASE_URL}/repository/repository_ajax.php?action=upload` ? jsonResponse({ url: `${BASE_URL}/draftfile.php/essay.pdf` }) : undefined,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31&action=submit` ? htmlResponse(CONFIRM_SUBMIT_HTML) : undefined,
      (request) => {
        if (request.url === `${BASE_URL}/mod/assign/view.php` && request.init?.method === "POST") {
          return htmlResponse("<html>ok</html>");
        }
        return undefined;
      },
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(SUBMITTED_VIEW_HTML) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const result = await submitAssignment(client, 31, [filePath], { finalize: true });

    expect(result.uploaded).toEqual([{ file: "essay.pdf", bytes: 4 }]);
    expect(result.submitted_for_grading).toBe(true);
    expect(result.submission_status).toBe("Submitted for grading");
    expect(result.submission_statement).toBe("This assignment is my own work.");

    const upload = seen.find((request) => request.url.includes("repository_ajax.php"));
    const form = upload?.init?.body as FormData;
    expect(form.get("itemid")).toBe("654321");
    expect(form.get("repo_id")).toBe("4");
    expect(form.get("ctx_id")).toBe("901");
    expect((form.get("repo_upload_file") as File).name).toBe("essay.pdf");

    const saves = seen.filter((request) => request.url === `${BASE_URL}/mod/assign/view.php` && request.init?.method === "POST");
    expect(saves).toHaveLength(2);
    expect(String(saves[0].init?.body)).toContain("action=savesubmission");
    expect(String(saves[0].init?.body)).toContain("files_filemanager=654321");
    expect(String(saves[1].init?.body)).toContain("action=confirmsubmit");
    expect(String(saves[1].init?.body)).toContain("submissionstatement=1");
  });

  it("saves without locking when finalize is off, and fails clearly when the form is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moodle-submit-"));
    const filePath = join(dir, "essay.pdf");
    await writeFile(filePath, "PDF!");

    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31&action=editsubmission` ? htmlResponse(EDIT_SUBMISSION_HTML) : undefined,
      (request) => request.url.startsWith(`${BASE_URL}/repository/`) ? jsonResponse({}) : undefined,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php` && request.init?.method === "POST" ? htmlResponse("ok") : undefined,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=31` ? htmlResponse(SUBMITTED_VIEW_HTML) : undefined,
      (request) => request.url === `${BASE_URL}/mod/assign/view.php?id=99&action=editsubmission` ? htmlResponse("<html>Nothing here</html>") : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const result = await submitAssignment(client, 31, [filePath]);
    expect(result.submitted_for_grading).toBe(false);
    expect(result.saved).toBe(true);

    await expect(submitAssignment(client, 99, [filePath])).rejects.toThrow(/submission form/i);
  });
});

describe("choice voting", () => {
  const choiceHtml = (checkedId: number) => `
<html><h1>Project topic</h1>
<form method="post" action="${BASE_URL}/mod/choice/view.php">
<input type="hidden" name="id" value="41">
<input type="hidden" name="action" value="makechoice">
<input type="hidden" name="sesskey" value="sesskey123">
<input type="radio" name="answer" value="11" id="c1"${checkedId === 11 ? " checked" : ""}><label for="c1">Topic A</label>
<input type="radio" name="answer" value="12" id="c2"${checkedId === 12 ? " checked" : ""}><label for="c2">Topic B</label>
<input type="submit" name="savemychoice" value="Save my choice">
</form></html>`;

  it("lists options and submits a vote", async () => {
    let voted = false;
    const { seen } = installFetch([
      dashboardRoute,
      (request) => {
        if (request.url === `${BASE_URL}/mod/choice/view.php?id=41` && request.init?.method !== "POST") {
          return htmlResponse(choiceHtml(voted ? 11 : 12));
        }
        return undefined;
      },
      (request) => {
        if (request.url === `${BASE_URL}/mod/choice/view.php` && request.init?.method === "POST") {
          voted = true;
          return htmlResponse("ok");
        }
        return undefined;
      },
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const before = await getChoice(client, 41);
    expect(before.options).toEqual([
      { id: 11, text: "Topic A", selected: false },
      { id: 12, text: "Topic B", selected: true },
    ]);
    expect(before.can_vote).toBe(true);
    expect(before.multiple).toBe(false);

    const after = await voteChoice(client, 41, [11]);
    expect(after.options.find((option) => option.id === 11)?.selected).toBe(true);

    const post = seen.find((request) => request.url === `${BASE_URL}/mod/choice/view.php` && request.init?.method === "POST");
    expect(String(post?.init?.body)).toContain("answer=11");
    expect(String(post?.init?.body)).toContain("action=makechoice");
  });

  it("rejects voting for an unknown option", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/choice/view.php?id=41` ? htmlResponse(choiceHtml(0)) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(voteChoice(client, 41, [99])).rejects.toThrow(/Option 99/);
  });
});

describe("feedback", () => {
  const feedbackHtml = `
<html><h1>Unit survey</h1>
<form method="post" action="${BASE_URL}/mod/feedback/complete.php">
<input type="hidden" name="id" value="51">
<input type="hidden" name="courseid" value="101">
<input type="hidden" name="gopage" value="0">
<input type="hidden" name="sesskey" value="sesskey123">
<div><span class="fitemtitle">Overall rating</span>
<input type="radio" name="feedback_item_5" value="1" id="f51" required><label for="f51">Poor</label>
<input type="radio" name="feedback_item_5" value="5" id="f55"><label for="f55">Great</label></div>
<div><span class="fitemtitle">Comments</span><textarea name="feedback_item_6"></textarea></div>
<button type="submit" name="savevalues">Submit your answers</button>
</form></html>`;

  it("lists questions with types and options", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/feedback/complete.php?id=51` ? htmlResponse(feedbackHtml) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const info = await getFeedback(client, 51);

    expect(info.questions).toEqual([
      {
        item_id: 5,
        name: "feedback_item_5",
        label: "Overall rating",
        type: "radio",
        required: true,
        options: [
          { value: "1", text: "Poor" },
          { value: "5", text: "Great" },
        ],
      },
      { item_id: 6, name: "feedback_item_6", label: "Comments", type: "textarea", required: false, options: [] },
    ]);
    expect(info.has_more_pages).toBe(false);
  });

  it("submits answers and reports completion", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/feedback/complete.php?id=51` && request.init?.method !== "POST" ? htmlResponse(feedbackHtml) : undefined,
      (request) => request.url === `${BASE_URL}/mod/feedback/complete.php` && request.init?.method === "POST"
        ? htmlResponse('<html><div class="generalbox">Your answers have been saved. Thank you.</div></html>')
        : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    const result = await completeFeedback(client, 51, { 5: "5", 6: "Great unit" });

    expect(result).toEqual({ id: 51, completed: true, pages_submitted: 1, message: "Your answers have been saved. Thank you." });
    const post = seen.find((request) => request.init?.method === "POST" && request.url.includes("complete.php"));
    const body = String(post?.init?.body);
    expect(body).toContain("feedback_item_5=5");
    expect(body).toContain(`feedback_item_6=${encodeURIComponent("Great unit").replace(/%20/g, "+")}`);
    expect(body).toContain("savevalues=");
  });

  it("rejects when a required question has no answer", async () => {
    installFetch([
      dashboardRoute,
      (request) => request.url === `${BASE_URL}/mod/feedback/complete.php?id=51` ? htmlResponse(feedbackHtml) : undefined,
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(completeFeedback(client, 51, { 6: "text only" })).rejects.toThrow(/Question 5/);
  });
});

describe("completion and notifications", () => {
  it("marks an activity complete through the completion AJAX function", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxRoute("core_completion_update_activity_completion_status_manually", { status: true }),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await expect(client.markActivityCompletion(88, true)).resolves.toBe(true);
    const call = seen.find((request) => request.url.includes("core_completion_update_activity_completion_status_manually"));
    expect(JSON.parse(String(call?.init?.body))[0].args).toEqual({ cmid: 88, completed: true });
  });

  it("marks all notifications as read", async () => {
    const { seen } = installFetch([
      dashboardRoute,
      ajaxRoute("core_message_mark_all_notifications_as_read", true),
    ]);
    const client = new MoodleClient(BASE_URL, "session");

    await client.markAllNotificationsRead();
    const call = seen.find((request) => request.url.includes("core_message_mark_all_notifications_as_read"));
    expect(JSON.parse(String(call?.init?.body))[0].args).toEqual({ useridto: 7 });
  });
});
