import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { MoodleClient } from "./client.js";
import { ASSIGN_VIEW_PATH, DRAFTFILES_AJAX_PATH, REPOSITORY_UPLOAD_PATH } from "./constants.js";
import { MoodleAPIError } from "./errors.js";
import type { AssignSubmitResult } from "./models.js";
import { parseContextId, parseFormWithField, parseSubmissionStatement, parseUploadRepositoryId } from "./scraper.js";

export interface AssignSubmitOptions {
  finalize?: boolean;
}

export async function submitAssignment(
  client: MoodleClient,
  cmid: number,
  filePaths: string[],
  options: AssignSubmitOptions = {},
): Promise<AssignSubmitResult> {
  const editHtml = await client.getHtml(ASSIGN_VIEW_PATH, { id: cmid, action: "editsubmission" });
  const form = parseFormWithField(editHtml, "action", "savesubmission", client.baseUrl);
  if (!form) {
    throw new MoodleAPIError(
      "Could not open the submission form. The assignment may be closed, already submitted and locked, or you may lack permission.",
    );
  }
  const itemid = form.fields.files_filemanager;
  if (!itemid) {
    throw new MoodleAPIError("This assignment has no file submission area (it may only accept online text).");
  }
  const repoId = parseUploadRepositoryId(editHtml);
  if (!repoId) {
    throw new MoodleAPIError("Could not find the upload repository on the submission form.");
  }
  const contextId = parseContextId(editHtml);
  const sesskey = await client.getSesskey();
  const clientId = randomUUID().replace(/-/g, "");

  const uploaded: Array<{ file: string; bytes: number }> = [];
  for (const path of filePaths) {
    const data = await readFile(path);
    const filename = basename(path);
    // Replace a same-named leftover from a previous submission in the draft area.
    try {
      await client.postFormUrlencoded(`${client.baseUrl}${DRAFTFILES_AJAX_PATH}?action=delete`, {
        sesskey,
        client_id: clientId,
        itemid,
        filepath: "/",
        filename,
      });
    } catch {
      // No existing file with this name.
    }
    const upload = new FormData();
    upload.set("sesskey", sesskey);
    upload.set("repo_id", String(repoId));
    upload.set("itemid", itemid);
    upload.set("ctx_id", String(contextId));
    upload.set("client_id", clientId);
    upload.set("env", "filemanager");
    upload.set("p", "");
    upload.set("page", "");
    upload.set("maxbytes", "-1");
    upload.set("areamaxbytes", "-1");
    upload.set("title", "");
    upload.set("repo_upload_file", new Blob([data]), filename);
    const result = await client.postMultipartJson(`${client.baseUrl}${REPOSITORY_UPLOAD_PATH}?action=upload`, upload);
    if (isRecord(result) && typeof result.error === "string" && result.error) {
      throw new MoodleAPIError(`Upload of ${filename} failed: ${result.error}`);
    }
    if (isRecord(result) && result.event === "fileexists") {
      throw new MoodleAPIError(`Upload of ${filename} failed: a file with this name already exists in the draft area.`);
    }
    uploaded.push({ file: filename, bytes: data.byteLength });
  }

  await client.postFormUrlencoded(form.action || `${client.baseUrl}${ASSIGN_VIEW_PATH}`, {
    ...form.fields,
    files_filemanager: itemid,
    submitbutton: "Save changes",
  });

  let submitted = false;
  let statement = "";
  if (options.finalize) {
    const submitHtml = await client.getHtml(ASSIGN_VIEW_PATH, { id: cmid, action: "submit" });
    const confirmForm = parseFormWithField(submitHtml, "action", "confirmsubmit", client.baseUrl);
    if (confirmForm) {
      statement = parseSubmissionStatement(submitHtml);
      const fields: Record<string, string> = { ...confirmForm.fields, submitbutton: "Continue" };
      if (statement) {
        fields.submissionstatement = "1";
      }
      await client.postFormUrlencoded(confirmForm.action || `${client.baseUrl}${ASSIGN_VIEW_PATH}`, fields);
      submitted = true;
    }
  }

  const assignment = await client.getAssignment(cmid);
  return {
    assign_id: cmid,
    uploaded,
    saved: true,
    submitted_for_grading: submitted,
    submission_status: assignment.submission_status,
    submission_statement: statement,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
