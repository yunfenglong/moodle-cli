import { HTMLElement, parse } from "node-html-parser";
import type { MoodleClient } from "./client.js";
import { FEEDBACK_COMPLETE_PATH } from "./constants.js";
import { MoodleAPIError, UsageError } from "./errors.js";
import { cleanText } from "./html-utils.js";
import type { FeedbackInfo, FeedbackQuestion, FeedbackSubmitResult } from "./models.js";

const MAX_PAGES = 20;

export async function getFeedback(client: MoodleClient, cmid: number): Promise<FeedbackInfo> {
  const html = await client.getHtml(FEEDBACK_COMPLETE_PATH, { id: cmid });
  return parseFeedbackPage(html, cmid, client.baseUrl, 0);
}

export async function completeFeedback(
  client: MoodleClient,
  cmid: number,
  answers: Record<number, string>,
): Promise<FeedbackSubmitResult> {
  let html = await client.getHtml(FEEDBACK_COMPLETE_PATH, { id: cmid });
  let pages = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const info = parseFeedbackPage(html, cmid, client.baseUrl, page);
    const form = findFeedbackForm(html, client.baseUrl);
    if (!form) {
      if (pages > 0) {
        return { id: cmid, completed: true, pages_submitted: pages, message: completionMessage(html) };
      }
      throw new MoodleAPIError("Could not open the feedback form. It may be closed or already completed.");
    }
    const fields: Record<string, string> = { ...form.fields };
    for (const question of info.questions) {
      const answer = answers[question.item_id];
      if (answer !== undefined) {
        fields[question.name] = answer;
      } else if (question.required && !fields[question.name]) {
        throw new UsageError(`Question ${question.item_id} ('${question.label}') is required. Provide --answer ${question.item_id}=<value>.`);
      }
    }
    fields[info.has_more_pages ? "gonextpage" : "savevalues"] = info.has_more_pages ? "Next page" : "Submit your answers";
    html = await client.postFormUrlencoded(form.action || `${client.baseUrl}${FEEDBACK_COMPLETE_PATH}`, fields);
    pages += 1;
    if (!info.has_more_pages) {
      return { id: cmid, completed: true, pages_submitted: pages, message: completionMessage(html) };
    }
  }
  throw new MoodleAPIError(`Feedback form did not finish after ${MAX_PAGES} pages.`);
}

export function parseFeedbackPage(html: string, cmid: number, baseUrl: string, page: number): FeedbackInfo {
  const root = parse(html);
  const questions: FeedbackQuestion[] = [];
  const seen = new Set<number>();
  for (const element of root.querySelectorAll('[name^="feedback_item_"], [name^="feedback_multichoice_item_"]')) {
    const name = element.getAttribute("name") ?? "";
    const itemId = Number(name.match(/(\d+)/)?.[1] ?? 0);
    if (!itemId || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    const tag = element.tagName?.toLowerCase() ?? "";
    const inputType = element.getAttribute("type") ?? "";
    let type = tag === "textarea" ? "textarea" : tag === "select" ? "select" : inputType || tag;
    const options: Array<{ value: string; text: string }> = [];
    if (tag === "select") {
      for (const option of element.querySelectorAll("option")) {
        const value = option.getAttribute("value") ?? "";
        if (value !== "") {
          options.push({ value, text: cleanText(option.textContent) });
        }
      }
    } else if (inputType === "radio" || inputType === "checkbox") {
      type = inputType;
      for (const input of root.querySelectorAll(`input[name="${name}"]`)) {
        const value = input.getAttribute("value") ?? "";
        if (value === "" || value === "0") {
          continue;
        }
        const id = input.getAttribute("id");
        const label = id ? root.querySelector(`label[for="${id}"]`) : null;
        options.push({ value, text: cleanText(label?.textContent ?? value) });
      }
    }
    questions.push({
      item_id: itemId,
      name,
      label: questionLabel(root, element, name),
      type,
      required: isRequired(element),
      options,
    });
  }
  return {
    id: cmid,
    name: cleanText(root.querySelector("h1")?.textContent ?? ""),
    page,
    has_more_pages: hasButton(root, "gonextpage"),
    questions,
    url: `${baseUrl.replace(/\/$/, "")}${FEEDBACK_COMPLETE_PATH}?id=${cmid}`,
  };
}

function findFeedbackForm(html: string, baseUrl: string): { action: string; fields: Record<string, string> } | null {
  const root = parse(html);
  for (const form of root.querySelectorAll("form")) {
    if (!form.querySelector('[name^="feedback_item_"], [name^="feedback_multichoice_item_"]') && !form.querySelector('input[name="savevalues"], button[name="savevalues"]')) {
      continue;
    }
    const fields: Record<string, string> = {};
    for (const input of form.querySelectorAll("input[type='hidden']")) {
      const name = input.getAttribute("name");
      if (name) {
        fields[name] = input.getAttribute("value") ?? "";
      }
    }
    const action = form.getAttribute("action") ?? "";
    return { action: action ? new URL(action, baseUrl).toString() : "", fields };
  }
  return null;
}

function questionLabel(root: HTMLElement, element: HTMLElement, name: string): string {
  const inputType = element.getAttribute("type") ?? "";
  const id = element.getAttribute("id");
  // For radio/checkbox groups, label[for] names the option, not the question.
  if (id && inputType !== "radio" && inputType !== "checkbox") {
    const label = root.querySelector(`label[for="${id}"]`);
    if (label) {
      return cleanText(label.textContent);
    }
  }
  let node: HTMLElement | null = element.parentNode as HTMLElement | null;
  for (let depth = 0; node && depth < 4; depth += 1) {
    const title = node.querySelector(".fitemtitle, .col-form-label, legend, .d-inline-block");
    if (title) {
      return cleanText(title.textContent);
    }
    node = node.parentNode as HTMLElement | null;
  }
  return name;
}

function isRequired(element: HTMLElement): boolean {
  if (element.hasAttribute("required")) {
    return true;
  }
  const parent = element.parentNode as HTMLElement | null;
  return Boolean(parent?.querySelector(".req, [title='Required field'], abbr[title*='equired']"));
}

function hasButton(root: HTMLElement, name: string): boolean {
  return root.querySelector(`input[name="${name}"], button[name="${name}"]`) !== null;
}

function completionMessage(html: string): string {
  const root = parse(html);
  const box = root.querySelector(".generalbox, .alert-success, [data-region='completion-message']");
  return cleanText(box?.textContent ?? "") || "Answers saved";
}
