import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";

export const SKILL_NAME = "moodle-cli";
export const SKILL_SOURCE = "https://github.com/bunizao/moodle-cli";
export const SKILLS_SPEC_URL = "https://github.com/vercel-labs/skills";
export const SKILL_DESCRIPTION =
  "Inspect Moodle data from the terminal with the `moodle` CLI. Use when an agent needs courses, deadlines, grades, alerts, activities, or forum discussions. Prefer JSON output for agent workflows.";

export interface SkillFlag {
  name: string;
  alias?: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
}

export interface SkillArgument {
  name: string;
  required?: boolean;
  variadic?: boolean;
}

export interface SkillCommand {
  name: string;
  path?: string[];
  description?: string;
  arguments?: SkillArgument[];
  flags?: SkillFlag[];
  children?: SkillCommand[];
}

interface GenerateOptions {
  commands: SkillCommand[];
  template: string;
}

type RunCommand = typeof spawnSync;

export function formatSkillSummary(): string {
  return [
    `Name: ${SKILL_NAME}`,
    `Description: ${SKILL_DESCRIPTION}`,
    `Source: ${SKILL_SOURCE}`,
    `Spec: ${SKILLS_SPEC_URL}`,
    `Install: npx skills add ${SKILL_SOURCE}`,
    "CLI alias: moodle skills add (falls back to npm exec)",
    "Generate: moodle skills generate",
  ].join("\n");
}

export function buildSkillsAddCommand(extraArgs: string[] = [], launcher: "npx" | "npm" = "npx"): string[] {
  if (launcher === "npx") {
    return ["npx", "skills", "add", SKILL_SOURCE, ...extraArgs];
  }
  return ["npm", "exec", "--yes", "--", "skills", "add", SKILL_SOURCE, ...extraArgs];
}

export function addSkill(extraArgs: string[] = [], options: {
  runCommand?: RunCommand;
  commandExists?: (name: string) => boolean;
} = {}): string[] {
  const runCommand = options.runCommand ?? spawnSync;
  const commandExists = options.commandExists ?? ((name: string) => isCommandAvailable(name, runCommand));
  const command = commandExists("npx")
    ? buildSkillsAddCommand(extraArgs, "npx")
    : commandExists("npm")
      ? buildSkillsAddCommand(extraArgs, "npm")
      : undefined;

  if (!command) {
    throw new Error(`npx or npm is required to install agent skills. Install Node.js, then run npx skills add ${SKILL_SOURCE}.`);
  }

  const [program, ...args] = command;
  const result = runCommand(program, args, { stdio: "inherit" }) as SpawnSyncReturns<Buffer>;
  if (result.error) {
    throw new Error(`Failed to launch ${command.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} exited with status ${result.status ?? "unknown"}.`);
  }

  return command;
}

export function installSkill(extraArgs: string[] = [], options: Parameters<typeof addSkill>[1] = {}): void {
  addSkill(extraArgs, options);
}

export function extractCommanderCommands(program: Command): SkillCommand[] {
  return collectCommandRows(program).map((row) => ({
    name: row.path.at(-1) ?? "",
    path: row.path,
    description: row.description,
    arguments: row.arguments,
    flags: row.flags,
  }));
}

export function generateSkillMarkdown(program: Command): string;
export function generateSkillMarkdown(options: GenerateOptions): string;
export function generateSkillMarkdown(input: Command | GenerateOptions): string {
  if (isGenerateOptions(input)) {
    return renderSkillMarkdown(input.commands, input.template);
  }

  const template = readSkillTemplate();
  return renderSkillMarkdown(extractCommanderCommands(input), template);
}

export function writeGeneratedSkill(program: Command, target = "SKILL.md"): void {
  writeFileSync(target, generateSkillMarkdown(program), "utf8");
}

function renderSkillMarkdown(commands: SkillCommand[], template: string): string {
  const replacements: Record<string, string> = {
    generated_frontmatter: renderFrontmatter(),
    generated_intent_table: renderIntentTable(),
    generated_command_reference: renderCommandReference(commands),
    generated_output_contract: renderOutputContract(),
  };

  let markdown = template;
  for (const [key, value] of Object.entries(replacements)) {
    markdown = markdown.replaceAll(`{{${key}}}`, value.trimEnd());
  }
  return `${markdown.trimEnd()}\n`;
}

function collectCommandRows(command: Command, parentPath: string[] = []): Array<Required<Pick<SkillCommand, "path">> & Omit<SkillCommand, "path" | "children">> {
  const isRoot = !(command as unknown as { parent?: Command }).parent;
  const commandPath = isRoot ? parentPath : [...parentPath, command.name()];
  const ownRows = isRoot || isHiddenCommand(command)
    ? []
    : [{
        name: command.name(),
        path: commandPath,
        description: command.description() || "",
        arguments: readArguments(command),
        flags: readFlags(command),
      }];

  const childRows = command.commands
    .filter((child) => !isHiddenCommand(child) && child.name() !== "help")
    .flatMap((child) => collectCommandRows(child, commandPath));
  return [...ownRows, ...childRows];
}

function readArguments(command: Command): SkillArgument[] {
  const args = ((command as unknown as { registeredArguments?: unknown[]; _args?: unknown[] }).registeredArguments
    ?? (command as unknown as { _args?: unknown[] })._args
    ?? []) as Array<Record<string, unknown>>;

  return args.map((arg) => {
    const nameValue = typeof arg.name === "function" ? arg.name.call(arg) : arg.name;
    return {
      name: String(nameValue ?? ""),
      required: Boolean(arg.required),
      variadic: Boolean(arg.variadic),
    };
  }).filter((arg) => arg.name);
}

function readFlags(command: Command): SkillFlag[] {
  return command.options.map((option) => {
    const value = option as unknown as Record<string, unknown>;
    return {
      name: typeof value.long === "string" ? value.long : findLongFlag(option.flags),
      alias: typeof value.short === "string" ? value.short : findShortFlag(option.flags),
      description: option.description ?? "",
      defaultValue: value.defaultValue,
      required: Boolean(value.required ?? value.mandatory),
    };
  }).filter((flag) => flag.name);
}

function renderFrontmatter(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTION}`,
    "---",
  ].join("\n");
}

function renderIntentTable(): string {
  return renderMarkdownTable(
    ["User intent", "Command"],
    [
      ["Show my profile or account info", "moodle user --json"],
      ["List my courses", "moodle courses --json"],
      ["Find nearest deadlines or upcoming actions", "moodle todo --limit 5 --days 14 --json"],
      ["List alerts or unread notifications", "moodle alerts --limit 10 --json"],
      ["Show a compact dashboard", "moodle overview --todo-limit 5 --alerts-limit 5 --json"],
      ["Show activities in a course", "moodle activities COURSE_ID --json"],
      ["Show course sections", "moodle course COURSE_ID --json"],
      ["Show grades for a course", "moodle grades COURSE_ID --json"],
      ["Find the best forum match", "moodle forum find QUERY --json"],
      ["Open a forum discussion URL or ID", "moodle forum discussion DISCUSSION_OR_URL --json"],
      ["Check whether the CLI has an update", "moodle update --json"],
      ["Install this agent skill", "moodle skills add"],
    ],
  );
}

function renderCommandReference(commands: SkillCommand[]): string {
  const rows = flattenCommands(commands)
    .sort((left, right) => commandPath(left).localeCompare(commandPath(right)))
    .map((command) => [
      `moodle ${commandPath(command)}`.trim(),
      command.description ?? "",
      renderArguments(command.arguments ?? []),
      renderFlags(command.flags ?? []),
    ]);

  return renderMarkdownTable(["Command", "Description", "Arguments", "Flags"], rows);
}

function renderOutputContract(): string {
  return [
    "### Output Contract",
    "",
    "- `--json` writes JSON to stdout.",
    "- `--yaml` writes YAML to stdout when supported.",
    "- `--table` forces human-readable table/tree output.",
    "- When stdout is not a TTY, commands default to JSON unless `--table` is set.",
    "- `--fields a,b,c` keeps only listed top-level fields. Arrays apply the field filter to each item.",
    "- Invalid `--fields` values are usage errors and list valid fields.",
    "- With JSON output enabled, errors are one JSON line on stderr: `{\"error\":true,\"code\":\"auth_failed\",\"message\":\"...\",\"hint\":\"...\"}`.",
    "",
    "Exit codes:",
    "",
    renderMarkdownTable(
      ["Code", "Meaning"],
      [
        ["0", "Success"],
        ["1", "Unexpected error"],
        ["2", "Authentication or configuration error"],
        ["3", "Usage error"],
        ["4", "Requested course, activity, forum, or discussion was not found"],
      ],
    ),
  ].join("\n");
}

function flattenCommands(commands: SkillCommand[]): SkillCommand[] {
  return commands.flatMap((command) => [command, ...flattenCommands(command.children ?? [])]);
}

function commandPath(command: SkillCommand): string {
  return (command.path?.length ? command.path : [command.name]).join(" ");
}

function renderArguments(args: SkillArgument[]): string {
  return args.map((arg) => {
    const name = arg.variadic ? `${arg.name}...` : arg.name;
    return arg.required ? `<${name}>` : `[${name}]`;
  }).join(" ");
}

function renderFlags(flags: SkillFlag[]): string {
  return flags.map((flag) => {
    const names = [flag.alias, flag.name].filter(Boolean).join(", ");
    const defaultValue = formatDefault(flag.defaultValue);
    const required = flag.required ? "value required" : "";
    const suffix = [defaultValue, required].filter(Boolean).join("; ");
    return suffix ? `${names} (${suffix})` : names;
  }).join("<br>");
}

function formatDefault(value: unknown): string {
  if (value === undefined || value === false) {
    return "";
  }
  return `default: ${Array.isArray(value) ? value.join(",") : String(value)}`;
}

function renderMarkdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function isCommandAvailable(name: string, runCommand: RunCommand): boolean {
  const result = runCommand(name, ["--version"], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
  return !result.error && result.status === 0;
}

function isHiddenCommand(command: Command): boolean {
  return Boolean((command as unknown as { hidden?: boolean; _hidden?: boolean }).hidden || (command as unknown as { _hidden?: boolean })._hidden);
}

function isGenerateOptions(value: Command | GenerateOptions): value is GenerateOptions {
  return "template" in value && "commands" in value;
}

function readSkillTemplate(): string {
  return readFileSync(path.join(process.cwd(), "src", "skill.template.md"), "utf8");
}

function findLongFlag(flags: string): string {
  return flags.split(/[,\s]+/).find((part) => part.startsWith("--")) ?? "";
}

function findShortFlag(flags: string): string | undefined {
  return flags.split(/[,\s]+/).find((part) => /^-[^-]/.test(part));
}
