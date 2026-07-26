import type { CalendarEvent } from "./models.js";

export function eventsToIcs(events: CalendarEvent[], now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//moodle-cli//EN",
    "CALSCALE:GREGORIAN",
  ];
  const stamp = icsDate(Math.floor(now.getTime() / 1000));
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:moodle-event-${event.id}@moodle-cli`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${icsDate(event.starts_at)}`);
    if (event.ends_at > event.starts_at) {
      lines.push(`DTEND:${icsDate(event.ends_at)}`);
    }
    lines.push(`SUMMARY:${escapeIcs(event.course_name ? `${event.name} (${event.course_name})` : event.name)}`);
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
    }
    if (event.location) {
      lines.push(`LOCATION:${escapeIcs(event.location)}`);
    }
    if (event.url) {
      lines.push(`URL:${event.url}`);
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function icsDate(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
