import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MoodleClient } from "./client.js";
import { executeDownloads, planFolderDownload, planResourceDownload, sanitizeFilename } from "./download.js";
import type { CourseExportSummary, DownloadItem, DownloadResult } from "./models.js";

export interface ExportOptions {
  dir: string;
  force?: boolean;
}

export async function exportCourse(client: MoodleClient, courseId: number, options: ExportOptions): Promise<CourseExportSummary> {
  const sections = await client.getCourseContents(courseId);
  const course = (await client.getCourses()).find((item) => item.id === courseId);
  const courseName = course?.fullname || course?.shortname || `course-${courseId}`;
  const root = join(options.dir, sanitizeFilename(courseName));
  await mkdir(root, { recursive: true });

  const indexLines = [`# ${courseName}`, ""];
  const files: DownloadResult[] = [];
  let pages = 0;
  let links = 0;

  for (const [index, section] of sections.entries()) {
    const sectionName = section.name || `Section ${section.section}`;
    const sectionDir = join(root, sanitizeFilename(`${String(index).padStart(2, "0")} ${sectionName}`));
    indexLines.push(`## ${sectionName}`, "");
    if (section.summary) {
      indexLines.push(section.summary, "");
    }
    const plans: DownloadItem[] = [];
    for (const activity of section.activities) {
      if (!activity.id) {
        continue;
      }
      if (activity.modname === "resource") {
        plans.push(...(await planResourceDownload(client, activity.id)));
        indexLines.push(`- [file] ${activity.name}`);
      } else if (activity.modname === "folder") {
        plans.push(...(await planFolderDownload(client, activity.id, activity.name)));
        indexLines.push(`- [folder] ${activity.name}`);
      } else if (activity.modname === "page") {
        const page = await client.getPage(activity.id);
        if (page.content_text) {
          await mkdir(sectionDir, { recursive: true });
          const file = join(sectionDir, sanitizeFilename(`${activity.name}.md`));
          await writeFile(file, `# ${page.name || activity.name}\n\n${page.url}\n\n${page.content_text}\n`);
          pages += 1;
        }
        indexLines.push(`- [page] ${activity.name}`);
      } else if (activity.modname === "url") {
        const link = await client.getLink(activity.id);
        indexLines.push(`- [link] ${activity.name}: ${link.target_url || activity.url}`);
        links += 1;
      } else {
        indexLines.push(`- [${activity.modname}] ${activity.name}${activity.url ? `: ${activity.url}` : ""}`);
      }
    }
    if (plans.length) {
      files.push(...(await executeDownloads(client, plans, { dir: sectionDir, force: options.force })));
    }
    indexLines.push("");
  }

  await writeFile(join(root, "README.md"), `${indexLines.join("\n").trimEnd()}\n`);
  return {
    course_id: courseId,
    course_name: courseName,
    dir: root,
    sections: sections.length,
    pages,
    links,
    files,
  };
}
