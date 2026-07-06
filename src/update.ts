import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { GITHUB_RELEASES_URL, NPM_LATEST_URL, PACKAGE_NAME } from "./constants.js";

export { GITHUB_RELEASES_URL, NPM_LATEST_URL, PACKAGE_NAME };

export interface UpdateInfo {
  package_name: string;
  current_version: string;
  latest_version: string;
  update_available: boolean;
  upgrade_commands: string[];
  npm_url: string;
  release_url: string;
}

type FetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
};

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponse>;

export type InstallMethod = "npm" | "binary" | "source" | "unknown";

export interface InstallContext {
  argv1?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class UpdateCheckError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "UpdateCheckError";
    this.cause = options?.cause;
  }
}

export async function checkForUpdates(currentVersion: string, fetchImpl: FetchLike = fetch): Promise<UpdateInfo> {
  const latestVersion = await fetchLatestVersion(fetchImpl);
  return {
    package_name: PACKAGE_NAME,
    current_version: currentVersion,
    latest_version: latestVersion,
    update_available: compareSemver(latestVersion, currentVersion) > 0,
    upgrade_commands: [
      `npm install -g ${PACKAGE_NAME}@latest`,
      `Download a standalone binary: ${GITHUB_RELEASES_URL}`,
    ],
    npm_url: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
    release_url: GITHUB_RELEASES_URL,
  };
}

export async function fetchLatestVersion(fetchImpl: FetchLike = fetch, registryUrl = NPM_LATEST_URL): Promise<string> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(registryUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new UpdateCheckError(errorMessage(error), { cause: error });
  }

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    throw new UpdateCheckError(`npm registry returned HTTP ${response.status}${statusText}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new UpdateCheckError("invalid response from npm registry", { cause: error });
  }

  const latestVersion = typeof payload === "object" && payload !== null ? (payload as { version?: unknown }).version : undefined;
  if (typeof latestVersion !== "string" || latestVersion.trim() === "") {
    throw new UpdateCheckError("missing version in npm registry response");
  }

  return latestVersion.trim();
}

export function formatUpdateCheckFailure(error: unknown): string {
  const message = errorMessage(error);
  return message.startsWith("Could not check for updates")
    ? message
    : `Could not check for updates: ${message}`;
}

export function detectInstallKind(argv1 = process.argv[1]): "npm" | "binary" {
  return detectInstallMethod({ argv1 }) === "npm" ? "npm" : "binary";
}

export function detectInstallMethod(context: InstallContext = {}): InstallMethod {
  const env = context.env ?? process.env;
  const explicit = env.MOODLE_CLI_INSTALL_METHOD?.toLowerCase();
  if (explicit === "npm" || explicit === "binary" || explicit === "source") {
    return explicit;
  }

  const argv1 = normalizePath(context.argv1 ?? process.argv[1] ?? "");
  const execPath = normalizePath(context.execPath ?? process.execPath ?? "");
  const scriptName = path.basename(argv1).toLowerCase();
  const executableName = path.basename(execPath).toLowerCase();

  if (argv1.includes("/node_modules/moodle-cli/") || argv1.includes("/node_modules/.bin/")) {
    return "npm";
  }
  if (scriptName === "moodle" || scriptName === "moodle.cmd" || scriptName === "moodle-cli") {
    return "npm";
  }
  if (!argv1 || executableName === "moodle" || executableName === "moodle.exe" || executableName === "moodle-cli") {
    return "binary";
  }
  if (argv1.includes("/src/") || argv1.endsWith("/src/cli.ts")) {
    return "source";
  }

  return "unknown";
}

export function applySelfUpdate(
  kind: InstallMethod = detectInstallKind(),
  options: { runCommand?: typeof spawnSync } = {},
): string {
  if (kind !== "npm") {
    return GITHUB_RELEASES_URL;
  }

  const runCommand = options.runCommand ?? spawnSync;
  const available = runCommand("npm", ["--version"], { stdio: "ignore" }) as SpawnSyncReturns<Buffer>;
  if (available.error || available.status !== 0) {
    throw new Error(`npm is required to update ${PACKAGE_NAME}. Download a binary from ${GITHUB_RELEASES_URL}`);
  }

  const command = ["npm", "install", "-g", `${PACKAGE_NAME}@latest`];
  const result = runCommand(command[0], command.slice(1), { stdio: "inherit" }) as SpawnSyncReturns<Buffer>;
  if (result.error) {
    throw new Error(`Failed to run ${command.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} exited with status ${result.status ?? "unknown"}`);
  }

  return command.join(" ");
}

export function compareVersions(left: string, right: string): number {
  return compareSemver(left, right);
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) {
    throw new UpdateCheckError(`invalid semver '${value}'`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) {
      return Number(a) > Number(b) ? 1 : -1;
    }
    if (numericA) return -1;
    if (numericB) return 1;
    return a > b ? 1 : -1;
  }

  return 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
