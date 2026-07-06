import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getAuthenticatedSession,
  loadSessionFromEnv,
  matchingMoodleSessionCookies,
} from "../src/auth.js";
import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import { ENV_MOODLE_BASE_URL, ENV_MOODLE_SESSION } from "../src/constants.js";
import { readCachedSession, writeCachedSession } from "../src/session-cache.js";
import { serializeStructured } from "../src/output.js";
import { runCli } from "../src/cli.js";

const BASE_URL = "https://school.example.edu";

describe("auth chain", () => {
  it("keeps MOODLE_SESSION as the winning source", async () => {
    const validateSession = vi.fn(async (_baseUrl: string, cookie: { name: string; value: string }) => {
      expect(cookie.value).toBe("env-cookie");
      return { sesskey: "sess", userid: 7 };
    });
    const browserCookieProvider = vi.fn(async () => [{ name: "MoodleSession", value: "browser-cookie", domain: "school.example.edu" }]);

    const session = await getAuthenticatedSession(BASE_URL, {
      env: { [ENV_MOODLE_SESSION]: "env-cookie" },
      validateSession,
      browserCookieProvider,
    });

    expect(session.cookie.value).toBe("env-cookie");
    expect(browserCookieProvider).not.toHaveBeenCalled();
  });

  it("matches suffixed MoodleSession cookies by host", () => {
    const matches = matchingMoodleSessionCookies(
      [
        { name: "MoodleSession", value: "wrong", domain: "other.example.edu" },
        { name: "MoodleSessionABC", value: "right", domain: ".school.example.edu" },
      ],
      BASE_URL,
    );

    expect(loadSessionFromEnv({ [ENV_MOODLE_SESSION]: "env" })?.value).toBe("env");
    expect(matches.map((cookie) => [cookie.name, cookie.value])).toEqual([["MoodleSessionABC", "right"]]);
  });
});

describe("config and session cache", () => {
  it("resolves config as env, cwd config, then user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "moodle-cli-"));
    const cwd = join(root, "cwd");
    const homeDir = join(root, "home");
    await writeFile(join(cwd, "config.yaml"), "base_url: https://cwd.example.edu\n", { flag: "wx" }).catch(async () => {
      await import("node:fs/promises").then((fs) => fs.mkdir(cwd, { recursive: true }));
      await writeFile(join(cwd, "config.yaml"), "base_url: https://cwd.example.edu\n");
    });
    await import("node:fs/promises").then((fs) => fs.mkdir(join(homeDir, ".config/moodle-cli"), { recursive: true }));
    await writeFile(join(homeDir, ".config/moodle-cli/config.yaml"), "base_url: https://home.example.edu\n");

    await expect(loadConfig({ cwd, homeDir, env: { [ENV_MOODLE_BASE_URL]: "https://env.example.edu" } })).resolves.toMatchObject({ baseUrl: "https://env.example.edu" });
    await expect(loadConfig({ cwd, homeDir, env: {} })).resolves.toMatchObject({ baseUrl: "https://cwd.example.edu" });
    await expect(loadConfig({ cwd: join(root, "empty"), homeDir, env: {} })).resolves.toMatchObject({ baseUrl: "https://home.example.edu" });
  });

  it("rejects non-root URLs and non-TTY missing config", async () => {
    expect(() => normalizeBaseUrl(`${BASE_URL}/login/index.php`)).toThrow(/site root/);
    await expect(loadConfig({ cwd: await mkdtemp(join(tmpdir(), "moodle-cli-empty-")), homeDir: await mkdtemp(join(tmpdir(), "moodle-cli-home-")), env: {}, stdin: { isTTY: false } })).rejects.toThrow(/MOODLE_BASE_URL/);
  });

  it("persists warm sessions with 0600 permissions and honors no-cache reads", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "moodle-cli-cache-"));
    await writeCachedSession(
      { baseUrl: BASE_URL, cookieName: "MoodleSession", cookieValue: "secret", sesskey: "sess", userid: 7, savedAt: 1000 },
      { homeDir },
    );

    const cached = await readCachedSession(BASE_URL, { homeDir, now: () => 1000 });
    expect(cached?.cookieValue).toBe("secret");
    expect(await readCachedSession(BASE_URL, { homeDir, noCache: true })).toBeNull();

    const mode = (await stat(join(homeDir, ".cache/moodle-cli/session.json"))).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = await readFile(join(homeDir, ".cache/moodle-cli/session.json"), "utf8");
    expect(JSON.parse(raw).sesskey).toBe("sess");
  });
});

describe("agent output contract", () => {
  it("filters fields and rejects unknown fields", () => {
    expect(serializeStructured([{ id: 1, name: "Course", empty: "" }], { format: "json", fields: "id,name" })).toBe('[{"id":1,"name":"Course"}]');
    expect(() => serializeStructured([{ id: 1 }], { format: "json", fields: "missing" })).toThrow(/Valid fields: id/);
  });

  it("auto-emits JSON on a pipe and emits JSON errors", async () => {
    const dashboard = '<script>M.cfg = {"sesskey":"sess","userId":7,"language":"en"};</script><body data-user-id="7"><span class="userfullname">Alice</span></body>';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${BASE_URL}/my/`) {
        return new Response(dashboard, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (init?.method === "POST" && url.includes("/lib/ajax/service.php")) {
        return new Response(JSON.stringify([{ error: false, data: { userid: 7, username: "alice", fullname: "Alice", sitename: "Campus", siteurl: BASE_URL } }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const stdout = buffer();
    const stderr = buffer();
    const code = await runCli(["node", "moodle", "user", "--fields", "userid,fullname"], {
      env: { [ENV_MOODLE_BASE_URL]: BASE_URL, [ENV_MOODLE_SESSION]: "cookie" },
      fetchImpl,
      stdout,
      stderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toBe('{"userid":7,"fullname":"Alice"}\n');
    expect(stderr.text()).toBe("");

    const errorStdout = buffer();
    const errorStderr = buffer();
    const errorCode = await runCli(["node", "moodle", "not-a-command"], {
      stdout: errorStdout,
      stderr: errorStderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      env: {},
    });
    expect(errorCode).toBe(3);
    expect(JSON.parse(errorStderr.text())).toMatchObject({ error: true, code: "usage_error" });
  });
});

function buffer() {
  let value = "";
  return {
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text() {
      return value;
    },
  };
}
