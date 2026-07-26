import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MoodleClient } from "./client.js";
import { NotFoundError, UsageError } from "./errors.js";
import type { DownloadItem, DownloadResult } from "./models.js";

export interface DownloadOptions {
  dir: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function planDownloads(client: MoodleClient, target?: string, courseId?: number): Promise<DownloadItem[]> {
  if (courseId !== undefined) {
    return planCourseDownloads(client, courseId);
  }
  if (!target) {
    throw new UsageError("Provide a resource/folder ID or URL, or use --course to download a whole course.");
  }
  const raw = target.trim();
  if (/^\d+$/.test(raw)) {
    return planResourceDownload(client, Number(raw));
  }
  const url = parseUrl(raw);
  if (!url) {
    throw new UsageError(`'${target}' is not a resource/folder ID or a URL.`);
  }
  const id = url.searchParams.get("id");
  if (url.pathname.endsWith("/mod/resource/view.php") && id) {
    return planResourceDownload(client, Number(id));
  }
  if (url.pathname.endsWith("/mod/folder/view.php") && id) {
    return planFolderDownload(client, Number(id), "");
  }
  if (url.pathname.endsWith("/mod/assign/view.php") && id) {
    const files = await client.getAssignmentSubmissionFiles(Number(id));
    if (!files.length) {
      throw new NotFoundError("No submitted files found on this assignment page.");
    }
    return files.map((file) => ({ name: file.name, url: file.url, source: `assign:${id}` }));
  }
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "") || url.hostname;
  return [{ name, url: url.toString(), source: "url" }];
}

export async function executeDownloads(client: MoodleClient, plans: DownloadItem[], options: DownloadOptions): Promise<DownloadResult[]> {
  if (options.dryRun) {
    return plans.map((plan) => ({ name: plan.name, file: "", url: plan.url, bytes: 0, status: "planned" }));
  }
  await mkdir(options.dir, { recursive: true });
  const results: DownloadResult[] = [];
  for (const plan of plans) {
    results.push(await downloadOne(client, plan, options));
  }
  return results;
}

async function downloadOne(client: MoodleClient, plan: DownloadItem, options: DownloadOptions): Promise<DownloadResult> {
  try {
    const download = await client.downloadBinary(plan.url);
    if (download.contentType.includes("text/html") && !download.finalUrl.includes("pluginfile.php")) {
      return { name: plan.name, file: "", url: plan.url, bytes: 0, status: "failed", error: "Server returned an HTML page, not a file. The activity may not expose a direct download." };
    }
    const filename = sanitizeFilename(download.filename || plan.name);
    const file = join(options.dir, filename);
    if (!options.force && (await fileExists(file))) {
      return { name: plan.name, file, url: plan.url, bytes: 0, status: "exists" };
    }
    await writeFile(file, download.bytes);
    return { name: plan.name, file, url: plan.url, bytes: download.bytes.byteLength, status: "downloaded" };
  } catch (error) {
    return { name: plan.name, file: "", url: plan.url, bytes: 0, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function planResourceDownload(client: MoodleClient, cmid: number): Promise<DownloadItem[]> {
  const resource = await client.getResource(cmid);
  return [{
    name: resource.target_name || resource.name || `resource-${cmid}`,
    url: resource.target_url || resource.url,
    source: `resource:${cmid}`,
  }];
}

export async function planFolderDownload(client: MoodleClient, cmid: number, prefix: string): Promise<DownloadItem[]> {
  const files = await client.getFolderFiles(cmid);
  return files.map((file) => ({
    name: prefix ? `${prefix} - ${file.name}` : file.name,
    url: file.url,
    source: `folder:${cmid}`,
  }));
}

async function planCourseDownloads(client: MoodleClient, courseId: number): Promise<DownloadItem[]> {
  const sections = await client.getCourseContents(courseId);
  const plans: DownloadItem[] = [];
  for (const activity of sections.flatMap((section) => section.activities)) {
    if (!activity.id) {
      continue;
    }
    if (activity.modname === "resource") {
      plans.push(...(await planResourceDownload(client, activity.id)));
    } else if (activity.modname === "folder") {
      plans.push(...(await planFolderDownload(client, activity.id, activity.name)));
    }
  }
  return plans;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "download";
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
