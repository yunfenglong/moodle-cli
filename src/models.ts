export interface UserInfo {
  userid: number;
  username: string;
  fullname: string;
  sitename: string;
  siteurl: string;
  lang?: string;
}

export interface PageContext {
  sesskey: string;
  user_info: UserInfo;
}

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  category: number;
  visible: boolean;
  startdate: number;
  enddate?: number;
}

export interface Activity {
  id: number;
  name: string;
  modname: string;
  url: string;
  visible: boolean;
  description: string;
}

export interface Section {
  id: number;
  name: string;
  section: number;
  visible: boolean;
  summary: string;
  activities: Activity[];
}

export interface TodoItem {
  id: number;
  name: string;
  activity_name: string;
  modname: string;
  course_id: number;
  course_name: string;
  due_at: number;
  overdue: boolean;
  actionable: boolean;
  action_name: string;
  action_url: string;
  url: string;
  event_type: string;
  course_progress?: number;
}

export interface AlertNotification {
  id: number;
  subject: string;
  short_subject: string;
  event_type: string;
  component: string;
  created_at: number;
  created_pretty: string;
  read: boolean;
  context_url: string;
  context_name: string;
}

export interface AlertSummary {
  notifications: AlertNotification[];
  notification_count: number;
  unread_notification_count: number;
  starred_message_count: number;
  direct_message_count: number;
  group_message_count: number;
  self_message_count: number;
  unread_starred_message_count: number;
  unread_direct_message_count: number;
  unread_group_message_count: number;
  unread_self_message_count: number;
}

export interface Overview {
  user: UserInfo;
  courses: Course[];
  todo: TodoItem[];
  alerts?: AlertSummary;
  errors: string[];
}

export interface GradeItem {
  name: string;
  item_type: string;
  grade: string;
  range: string;
  percentage: string;
  weight: string;
  contribution: string;
  feedback: string;
  url: string;
  status: string;
}

export interface CourseGrades {
  course_id: number;
  course_name: string;
  learner_name: string;
  total_grade: string;
  total_range: string;
  total_percentage: string;
  items: GradeItem[];
}

export interface GradeOverviewRow {
  course_id: number;
  course_name: string;
  grade: string;
  url: string;
}

export interface Conversation {
  id: number;
  name: string;
  type: string;
  member_count: number;
  unread_count: number;
  is_favourite: boolean;
  last_message: string;
  last_message_at: number;
  last_sender: string;
}

export interface ConversationMessage {
  id: number;
  sender_id: number;
  sender_name: string;
  text: string;
  sent_at: number;
}

export interface ConversationDetail {
  id: number;
  name: string;
  member_count: number;
  messages: ConversationMessage[];
}

export interface CalendarEvent {
  id: number;
  name: string;
  description: string;
  course_id: number;
  course_name: string;
  modname: string;
  event_type: string;
  starts_at: number;
  ends_at: number;
  location: string;
  url: string;
}

export interface CourseSearchHit {
  course_id: number;
  course_name: string;
  section_name: string;
  activity_id: number;
  activity_name: string;
  modname: string;
  matched_in: string;
  snippet: string;
  url: string;
}

export interface CourseExportSummary {
  course_id: number;
  course_name: string;
  dir: string;
  sections: number;
  pages: number;
  links: number;
  files: DownloadResult[];
}

export interface AssignSubmitResult {
  assign_id: number;
  uploaded: Array<{ file: string; bytes: number }>;
  saved: boolean;
  submitted_for_grading: boolean;
  submission_status: string;
  submission_statement: string;
}

export interface ChoiceOption {
  id: number;
  text: string;
  selected: boolean;
}

export interface ChoiceInfo {
  id: number;
  name: string;
  can_vote: boolean;
  multiple: boolean;
  options: ChoiceOption[];
  url: string;
}

export interface FeedbackQuestion {
  item_id: number;
  name: string;
  label: string;
  type: string;
  required: boolean;
  options: Array<{ value: string; text: string }>;
}

export interface FeedbackInfo {
  id: number;
  name: string;
  page: number;
  has_more_pages: boolean;
  questions: FeedbackQuestion[];
  url: string;
}

export interface FeedbackSubmitResult {
  id: number;
  completed: boolean;
  pages_submitted: number;
  message: string;
}

export interface CompletionResult {
  cmid: number;
  completed: boolean;
  updated: boolean;
}

export interface DownloadItem {
  name: string;
  url: string;
  source: string;
  relative_path?: string;
  content?: string;
}

export interface DownloadResult {
  name: string;
  file: string;
  url: string;
  bytes: number;
  status: "downloaded" | "exists" | "planned" | "failed";
  error?: string;
}

export interface Assignment {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  due_pretty: string;
  submission_status: string;
  grading_status: string;
  time_remaining: string;
  grade: string;
  submission_files: string[];
  url: string;
}

export interface Quiz {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  opens_pretty: string;
  closes_pretty: string;
  attempts_allowed: string;
  availability: string;
  grade: string;
  url: string;
}

export interface Resource {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  target_name: string;
  target_url: string;
  url: string;
}

export interface Link {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  target_url: string;
  url: string;
}

export interface Page {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  content_text: string;
  content_html: string;
  image_urls: string[];
  links: Array<{ text: string; url: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  files: Array<{ name: string; url: string }>;
  url: string;
}

export interface Folder {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  section_name: string;
  files: string[];
  url: string;
}

export type ActivityDetail = Assignment | Quiz | Resource | Link | Page | Folder;

export interface ForumPostAuthor {
  id: number;
  fullname: string;
  profile_url: string;
  profile_image_url: string;
}

export interface ForumPost {
  id: number;
  discussion_id: number;
  subject: string;
  message_html: string;
  message_text: string;
  image_urls: string[];
  links: Array<{ text: string; url: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  author: ForumPostAuthor;
  parent_id: number;
  time_created: number;
  time_modified: number;
  created_pretty: string;
  unread: boolean;
  is_deleted: boolean;
  is_private_reply: boolean;
  url: string;
  reply_url: string;
}

export interface ForumDiscussion {
  id: number;
  subject: string;
  course_id: number;
  forum_id: number;
  group_id: number;
  group_name: string;
  url: string;
  posts: ForumPost[];
}

export interface ForumDiscussionRef {
  id: number;
  subject: string;
  group_id: number;
  group_name: string;
  url: string;
}

export interface ForumActivityRef {
  id: number;
  name: string;
  course_id: number;
  course_name: string;
  url: string;
}

export interface ForumSearchHit {
  course_id: number;
  course_name: string;
  forum_id: number;
  forum_name: string;
  group_id: number;
  group_name: string;
  discussion_id: number;
  discussion_subject: string;
  post_id: number;
  author_name: string;
  matched_in: string;
  snippet: string;
  unread: boolean;
  time_created: number;
  url: string;
}

export interface ForumCheckResult {
  discussion_id: number;
  subject: string;
  ok: boolean;
  posts?: number;
  images?: number;
  error?: string;
}
