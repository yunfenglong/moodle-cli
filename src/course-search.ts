import type { MoodleClient } from "./client.js";
import { htmlToStructuredContent } from "./html-utils.js";
import type { Course, CourseSearchHit } from "./models.js";

export interface CourseSearchOptions {
  courseId?: number;
  limit?: number;
}

const MATCH_PRIORITY: Record<string, number> = { name: 0, section: 1, description: 2 };

export async function searchCourseContent(client: MoodleClient, query: string, options: CourseSearchOptions = {}): Promise<CourseSearchHit[]> {
  const limit = options.limit ?? 20;
  const allCourses = await client.getCourses();
  const courses: Course[] = options.courseId
    ? allCourses.filter((course) => course.id === options.courseId)
    : allCourses;
  if (options.courseId && !courses.length) {
    courses.push({ id: options.courseId, shortname: "", fullname: "", category: 0, visible: true, startdate: 0 });
  }
  const hits: CourseSearchHit[] = [];
  const results = await Promise.allSettled(
    courses.map(async (course) => ({ course, sections: await client.getCourseContents(course.id) })),
  );
  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const { course, sections } = result.value;
    const courseName = course.fullname || course.shortname;
    for (const section of sections) {
      if (queryMatches(section.name, query)) {
        hits.push({
          course_id: course.id,
          course_name: courseName,
          section_name: section.name,
          activity_id: 0,
          activity_name: "",
          modname: "section",
          matched_in: "section",
          snippet: snippet(section.summary),
          url: "",
        });
      }
      for (const activity of section.activities) {
        const descriptionText = snippet(activity.description);
        const matchedIn = queryMatches(activity.name, query)
          ? "name"
          : descriptionText && queryMatches(descriptionText, query)
            ? "description"
            : null;
        if (!matchedIn) {
          continue;
        }
        hits.push({
          course_id: course.id,
          course_name: courseName,
          section_name: section.name,
          activity_id: activity.id,
          activity_name: activity.name,
          modname: activity.modname,
          matched_in: matchedIn,
          snippet: descriptionText,
          url: activity.url,
        });
      }
    }
  }
  hits.sort((a, b) => (MATCH_PRIORITY[a.matched_in] ?? 9) - (MATCH_PRIORITY[b.matched_in] ?? 9));
  return hits.slice(0, limit);
}

function snippet(html: string, maxLen = 120): string {
  const text = html ? htmlToStructuredContent(html, "").text.split(/\s+/).filter(Boolean).join(" ") : "";
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

function queryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase().split(/\s+/).join(" ");
  const needle = query.toLowerCase().split(/\s+/).join(" ");
  return needle ? haystack.includes(needle) || needle.split(" ").every((token) => haystack.includes(token)) : true;
}
