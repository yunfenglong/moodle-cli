import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addSkill,
  buildSkillsAddCommand,
  extractCommanderCommands,
  formatSkillSummary,
  generateSkillMarkdown,
} from "../src/skills.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe("skills install wrappers", () => {
  it("builds the npx skills add command", () => {
    expect(buildSkillsAddCommand(["--agent", "codex"])).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
  });

  it("falls back to npm exec when npx is unavailable", () => {
    expect(buildSkillsAddCommand(["--agent", "codex"], "npm")).toEqual([
      "npm",
      "exec",
      "--yes",
      "--",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
  });

  it("delegates to npx without making a real subprocess", () => {
    spawnSyncMock.mockReturnValue({ status: 0 } as never);

    const command = addSkill(["--agent", "codex"]);

    expect(command).toEqual([
      "npx",
      "skills",
      "add",
      "https://github.com/bunizao/moodle-cli",
      "--agent",
      "codex",
    ]);
    expect(spawnSyncMock).toHaveBeenCalledWith("npx", ["--version"], { stdio: "ignore" });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "https://github.com/bunizao/moodle-cli", "--agent", "codex"],
      { stdio: "inherit" },
    );
  });
});

describe("skill generation", () => {
  it("summarizes the skill entrypoint", () => {
    expect(formatSkillSummary()).toContain("Generate: moodle skills generate");
  });

  it("extracts public commands from a commander-like tree", () => {
    const program = new Command("moodle");
    program.command("courses").description("List enrolled courses.").option("-j, --json", "Output as JSON.").option("--fields <fields>", "Keep only these fields.");
    const internal = program.command("internal").description("Hidden command.");
    (internal as unknown as { hidden: boolean }).hidden = true;

    const commands = extractCommanderCommands(program);

    expect(commands).toEqual([
      {
        name: "courses",
        path: ["courses"],
        description: "List enrolled courses.",
        arguments: [],
        flags: [
          { name: "--json", alias: "-j", description: "Output as JSON.", defaultValue: undefined, required: false },
          { name: "--fields", alias: undefined, description: "Keep only these fields.", defaultValue: undefined, required: true },
        ],
      },
    ]);
  });

  it("renders deterministic SKILL.md content from command specs", () => {
    const markdown = generateSkillMarkdown({
      template: "{{generated_frontmatter}}\n\n{{generated_command_reference}}\n\n{{generated_output_contract}}\n",
      commands: [
        {
          name: "todo",
          path: ["todo"],
          description: "List upcoming actionable timeline items.",
          flags: [
            { name: "--limit", description: "Maximum number of items.", defaultValue: 20 },
            { name: "--fields", description: "Keep only these fields." },
          ],
        },
      ],
    });

    expect(markdown).toContain("name: moodle-cli");
    expect(markdown).toContain("| moodle todo | List upcoming actionable timeline items. |  | --limit (default: 20)<br>--fields |");
    expect(markdown).toContain("`--fields a,b,c` keeps only listed top-level fields");
    expect(markdown).toBe(generateSkillMarkdown({
      template: "{{generated_frontmatter}}\n\n{{generated_command_reference}}\n\n{{generated_output_contract}}\n",
      commands: [
        {
          name: "todo",
          path: ["todo"],
          description: "List upcoming actionable timeline items.",
          flags: [
            { name: "--limit", description: "Maximum number of items.", defaultValue: 20 },
            { name: "--fields", description: "Keep only these fields." },
          ],
        },
      ],
    }));
  });
});
