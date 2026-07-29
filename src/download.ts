import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { MoodleClient } from "./client.js";
import { NotFoundError, UsageError } from "./errors.js";
import { htmlToMarkdown } from "./html-utils.js";
import type { DownloadItem, DownloadResult } from "./models.js";

export interface DownloadOptions {
  dir: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function planDownloads(client: MoodleClient, target?: string, courseId?: number, sectionNumber?: number): Promise<DownloadItem[]> {
  if (courseId !== undefined) {
    return planCourseDownloads(client, courseId, sectionNumber);
  }
  if (!target) {
    throw new UsageError("Provide a resource/Page module ID or URL, a folder URL, or use --course to download a whole course.");
  }
  const raw = target.trim();
  if (/^\d+$/.test(raw)) {
    return planCourseModuleDownload(client, Number(raw));
  }
  const url = parseUrl(raw);
  if (!url) {
    throw new UsageError(`'${target}' is not a resource/Page module ID or a URL.`);
  }
  const id = url.searchParams.get("id");
  if (url.pathname.endsWith("/mod/resource/view.php") && id) {
    return planResourceDownload(client, Number(id));
  }
  if (url.pathname.endsWith("/mod/folder/view.php") && id) {
    return planFolderDownload(client, Number(id), "");
  }
  if (url.pathname.endsWith("/mod/page/view.php") && id) {
    return planPageDownloads(client, Number(id));
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
    if (plan.content !== undefined) {
      const file = join(options.dir, plan.relative_path ?? sanitizeFilename(plan.name));
      if (!options.force && (await fileExists(file))) {
        return { name: plan.name, file, url: plan.url, bytes: 0, status: "exists" };
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, plan.content);
      return { name: plan.name, file, url: plan.url, bytes: Buffer.byteLength(plan.content), status: "downloaded" };
    }
    const download = await client.downloadBinary(plan.url);
    if (download.contentType.includes("text/html") && !isHtmlFilePlan(plan, download.filename)) {
      return { name: plan.name, file: "", url: plan.url, bytes: 0, status: "failed", error: "Server returned an HTML page, not a file. The activity may not expose a direct download." };
    }
    const relativePath = plan.relative_path ?? sanitizeFilename(download.filename || plan.name);
    const file = join(options.dir, relativePath);
    if (!options.force && (await fileExists(file))) {
      return { name: plan.name, file, url: plan.url, bytes: 0, status: "exists" };
    }
    await mkdir(dirname(file), { recursive: true });
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

async function planCourseModuleDownload(client: MoodleClient, cmid: number): Promise<DownloadItem[]> {
  let resourceError: unknown;
  let resourceFallback: DownloadItem[] | undefined;
  try {
    const resource = await client.getResource(cmid);
    if (resource.target_url) {
      return [{
        name: resource.target_name || resource.name || `resource-${cmid}`,
        url: resource.target_url,
        source: `resource:${cmid}`,
      }];
    }
    resourceFallback = [{
      name: resource.target_name || resource.name || `resource-${cmid}`,
      url: resource.url,
      source: `resource:${cmid}`,
    }];
  } catch (error) {
    resourceError = error;
  }
  try {
    return await planPageDownloads(client, cmid);
  } catch (pageError) {
    if (resourceFallback) {
      return resourceFallback;
    }
    throw resourceError ?? pageError;
  }
}

export async function planFolderDownload(client: MoodleClient, cmid: number, prefix: string): Promise<DownloadItem[]> {
  const files = await client.getFolderFiles(cmid);
  return files.map((file) => ({
    name: prefix ? `${prefix} - ${file.name}` : file.name,
    url: file.url,
    source: `folder:${cmid}`,
  }));
}

export async function planPageDownloads(client: MoodleClient, cmid: number): Promise<DownloadItem[]> {
  const page = await client.getPage(cmid);
  const pageName = sanitizeFilename(page.name || `page-${cmid}`);
  const assetsDir = `${pageName}.assets`;
  const usedNames = new Set<string>();
  const assetPaths = new Map<string, string>();
  const assets = page.files.map((file) => {
    const filename = uniqueFilename(sanitizeFilename(file.name), usedNames);
    const relativePath = `${assetsDir}/${filename}`;
    assetPaths.set(canonicalDownloadUrl(file.url), relativePath);
    return {
      name: filename,
      url: file.url,
      source: `page:${cmid}`,
      relative_path: relativePath,
    };
  });
  const body = htmlToMarkdown(page.content_html, client.baseUrl, (url) =>
    assetPaths.get(canonicalDownloadUrl(url)) ?? url
  );
  const markdown = `# ${page.name || pageName}\n\n${page.url}\n\n${body}\n`;
  return [{
    name: `${pageName}.md`,
    url: page.url,
    source: `page:${cmid}:content`,
    relative_path: `${pageName}.md`,
    content: markdown,
  }, ...assets];
}

async function planCourseDownloads(client: MoodleClient, courseId: number, sectionNumber?: number): Promise<DownloadItem[]> {
  const sections = await client.getCourseContents(courseId);
  const selectedSections = sectionNumber === undefined
    ? sections
    : sections.filter((section) => section.section === sectionNumber);
  if (sectionNumber !== undefined && !selectedSections.length) {
    throw new NotFoundError(`Week ${sectionNumber} was not found in course ${courseId}.`);
  }
  const plans: DownloadItem[] = [];
  for (const section of selectedSections) {
    for (const activity of section.activities) {
      if (!activity.id) {
        continue;
      }
      if (activity.modname === "resource") {
        plans.push(...(await planResourceDownload(client, activity.id)));
      } else if (activity.modname === "folder") {
        plans.push(...(await planFolderDownload(client, activity.id, activity.name)));
      } else if (activity.modname === "page") {
        plans.push(...(await planPageDownloads(client, activity.id)));
      }
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

function uniqueFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let index = 2;
  let candidate = `${stem} (${index})${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem} (${index})${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function canonicalDownloadUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete("forcedownload");
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function isHtmlFilePlan(plan: DownloadItem, responseFilename: string): boolean {
  return [plan.relative_path, responseFilename, plan.name]
    .filter((value): value is string => Boolean(value))
    .some((value) => /\.html?$/i.test(value));
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
