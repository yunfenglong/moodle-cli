import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GITHUB_RELEASES_URL,
  NPM_LATEST_URL,
  applySelfUpdate,
  checkForUpdates,
  compareVersions,
  detectInstallMethod,
  formatUpdateCheckFailure,
} from "../src/update.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe("update checks", () => {
  it("reports current and latest versions from the npm registry", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ version: "0.5.0" }),
    }));

    const info = await checkForUpdates("0.4.2", fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(NPM_LATEST_URL, {
      headers: { accept: "application/json" },
    });
    expect(info).toMatchObject({
      package_name: "moodle-cli",
      current_version: "0.4.2",
      latest_version: "0.5.0",
      update_available: true,
      release_url: GITHUB_RELEASES_URL,
    });
  });

  it("formats network failures with the legacy update wording", async () => {
    const error = await checkForUpdates(
      "0.4.2",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    ).catch((caught: unknown) => caught);

    expect(formatUpdateCheckFailure(error)).toBe("Could not check for updates: offline");
  });

  it("compares semver without a dependency", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
  });
});

describe("self update", () => {
  it("detects npm installs from node_modules paths", () => {
    expect(
      detectInstallMethod({
        argv1: "/usr/local/lib/node_modules/moodle-cli/dist/cli.js",
        execPath: "/usr/local/bin/node",
      }),
    ).toBe("npm");
  });

  it("runs npm self-update for npm installs", () => {
    spawnSyncMock.mockReturnValue({ status: 0 } as never);

    const result = applySelfUpdate("npm");

    expect(spawnSyncMock).toHaveBeenCalledWith("npm", ["--version"], { stdio: "ignore" });
    expect(spawnSyncMock).toHaveBeenCalledWith("npm", ["install", "-g", "moodle-cli@latest"], { stdio: "inherit" });
    expect(result).toBe("npm install -g moodle-cli@latest");
  });

  it("returns a GitHub release URL for standalone binaries", () => {
    const result = applySelfUpdate("binary");

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(result).toBe(GITHUB_RELEASES_URL);
  });
});
