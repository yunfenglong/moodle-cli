import { HTMLElement, parse } from "node-html-parser";
import type { MoodleClient } from "./client.js";
import { CHOICE_VIEW_PATH } from "./constants.js";
import { MoodleAPIError, NotFoundError } from "./errors.js";
import { cleanText } from "./html-utils.js";
import type { ChoiceInfo, ChoiceOption } from "./models.js";
import { parseFormWithField } from "./scraper.js";

export async function getChoice(client: MoodleClient, cmid: number): Promise<ChoiceInfo> {
  return parseChoiceHtml(await client.getHtml(CHOICE_VIEW_PATH, { id: cmid }), cmid, client.baseUrl);
}

export async function voteChoice(client: MoodleClient, cmid: number, answers: number[]): Promise<ChoiceInfo> {
  const html = await client.getHtml(CHOICE_VIEW_PATH, { id: cmid });
  const info = parseChoiceHtml(html, cmid, client.baseUrl);
  const form = parseFormWithField(html, "action", "makechoice", client.baseUrl);
  if (!form || !info.can_vote) {
    throw new MoodleAPIError("Voting is not open on this choice (closed, already answered without update allowed, or no permission).");
  }
  const known = new Set(info.options.map((option) => option.id));
  for (const answer of answers) {
    if (!known.has(answer)) {
      throw new NotFoundError(`Option ${answer} does not exist. Run 'moodle choice ${cmid}' to list option IDs.`);
    }
  }
  const fields: Record<string, string | string[]> = {
    ...form.fields,
    savemychoice: "Save my choice",
  };
  if (info.multiple) {
    fields["answer[]"] = answers.map(String);
  } else {
    fields.answer = String(answers[0]);
  }
  await client.postFormUrlencoded(form.action || `${client.baseUrl}${CHOICE_VIEW_PATH}`, fields);
  return getChoice(client, cmid);
}

export function parseChoiceHtml(html: string, cmid: number, baseUrl: string): ChoiceInfo {
  const root = parse(html);
  const options: ChoiceOption[] = [];
  const multiple = root.querySelector('input[name="answer[]"]') !== null;
  for (const input of root.querySelectorAll('input[name="answer"], input[name="answer[]"]')) {
    const value = input.getAttribute("value") ?? "";
    if (!/^\d+$/.test(value)) {
      continue;
    }
    const id = input.getAttribute("id");
    const label = id ? root.querySelector(`label[for="${id}"]`) : null;
    const container = label ?? (input.parentNode as HTMLElement | null);
    options.push({
      id: Number(value),
      text: cleanText(container?.textContent ?? ""),
      selected: input.hasAttribute("checked"),
    });
  }
  return {
    id: cmid,
    name: cleanText(root.querySelector("h1")?.textContent ?? ""),
    can_vote: parseFormWithField(html, "action", "makechoice", baseUrl) !== null,
    multiple,
    options,
    url: `${baseUrl.replace(/\/$/, "")}${CHOICE_VIEW_PATH}?id=${cmid}`,
  };
}
