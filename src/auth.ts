import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DASHBOARD_PATH,
  ENV_MOODLE_SESSION,
  LOGIN_PATH,
  MOODLE_SESSION_COOKIE_PREFIX,
  OKTA_AUTH_CONFIG_COMMAND,
  OKTA_AUTH_INSTALL_COMMAND,
  OKTA_AUTH_URL,
} from "./constants.js";
import { AuthError } from "./errors.js";
import {
  deleteCachedSession,
  readCachedSession,
  writeCachedSession,
  type CachedSession,
} from "./session-cache.js";

export interface MoodleSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  source?: string;
}

export interface SessionValidation {
  sesskey: string;
  userid: number;
}

export interface AuthenticatedSession extends SessionValidation {
  baseUrl: string;
  cookie: MoodleSessionCookie;
  fromCache: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFile = (file: string, args: string[]) => Promise<CommandResult>;
export type CookieProvider = (baseUrl: string, options: AuthOptions) => Promise<MoodleSessionCookie[]>;
export type SessionValidator = (baseUrl: string, cookie: MoodleSessionCookie) => Promise<SessionValidation | null>;

export interface AuthOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  validateSession?: SessionValidator;
  browserCookieProvider?: CookieProvider;
  oktaCookieProvider?: CookieProvider;
  execFile?: ExecFile;
  homeDir?: string;
  platform?: NodeJS.Platform;
  noCache?: boolean;
  cacheTtlMs?: number;
  now?: () => number;
  nonInteractive?: boolean;
}

interface ChromeCookiesSecure {
  getCookiesPromised(
    url: string,
    format: "puppeteer",
    profileOrPath?: string,
  ): Promise<Array<{ name: string; value: string; domain?: string; path?: string }>>;
}

export async function getAuthenticatedSession(
  baseUrl: string,
  options: AuthOptions = {},
): Promise<AuthenticatedSession> {
  const envSession = loadSessionFromEnv(options.env);
  const validate = options.validateSession ?? validateSessionWithFetch(options);

  if (envSession) {
    const context = await validate(baseUrl, envSession);
    if (!context) {
      throw new AuthError(
        `${ENV_MOODLE_SESSION} is set but did not authenticate for ${baseUrl}.`,
        authFailureHint(baseUrl),
      );
    }
    await refreshSessionCache(baseUrl, envSession, context, options);
    return { baseUrl, cookie: envSession, ...context, fromCache: false };
  }

  const cached = await readCache(baseUrl, options);
  if (cached) {
    return cached;
  }

  const browserProvider = options.browserCookieProvider ?? defaultBrowserCookieProvider;
  const browserCookies = matchingMoodleSessionCookies(await browserProvider(baseUrl, options), baseUrl);
  const browserSession = await firstValidSession(baseUrl, browserCookies, validate);
  if (browserSession) {
    await refreshSessionCache(baseUrl, browserSession.cookie, browserSession.context, options);
    return { baseUrl, cookie: browserSession.cookie, ...browserSession.context, fromCache: false };
  }

  const oktaProvider = options.oktaCookieProvider ?? loadSessionsFromOktaCli;
  const oktaCookies = matchingMoodleSessionCookies(await oktaProvider(baseUrl, options), baseUrl);
  const oktaSession = await firstValidSession(baseUrl, oktaCookies, validate);
  if (oktaSession) {
    await refreshSessionCache(baseUrl, oktaSession.cookie, oktaSession.context, options);
    return { baseUrl, cookie: oktaSession.cookie, ...oktaSession.context, fromCache: false };
  }

  if (!options.oktaCookieProvider && oktaCookies.length && !options.nonInteractive) {
    const refreshed = matchingMoodleSessionCookies(
      await loadSessionsFromOktaCli(baseUrl, { ...options, oktaCookieProvider: undefined, noCache: true }, true),
      baseUrl,
    );
    const refreshedSession = await firstValidSession(baseUrl, refreshed, validate);
    if (refreshedSession) {
      await refreshSessionCache(baseUrl, refreshedSession.cookie, refreshedSession.context, options);
      return { baseUrl, cookie: refreshedSession.cookie, ...refreshedSession.context, fromCache: false };
    }
  }

  throw new AuthError(`No usable MoodleSession found for ${baseUrl}.`, authFailureHint(baseUrl));
}

export function loadSessionFromEnv(env: Record<string, string | undefined> = process.env): MoodleSessionCookie | null {
  const value = env[ENV_MOODLE_SESSION]?.trim();
  return value ? { name: MOODLE_SESSION_COOKIE_PREFIX, value, source: "env" } : null;
}

export function matchingMoodleSessionCookies(cookies: MoodleSessionCookie[], baseUrl: string): MoodleSessionCookie[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const ranked: Array<{ cookie: MoodleSessionCookie; rank: number; index: number }> = [];
  const seen = new Set<string>();

  cookies.forEach((cookie, index) => {
    if (!cookie.name.startsWith(MOODLE_SESSION_COOKIE_PREFIX) || !cookie.value) {
      return;
    }
    const rank = cookieHostRank(cookie.domain, host);
    if (rank === null) {
      return;
    }
    const key = `${cookie.name}\0${cookie.value}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    ranked.push({ cookie, rank, index });
  });

  return ranked
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ cookie }) => cookie);
}

export async function defaultBrowserCookieProvider(
  baseUrl: string,
  options: AuthOptions = {},
): Promise<MoodleSessionCookie[]> {
  const chromiumCookies = await loadChromiumCookies(baseUrl, options);
  const firefoxCookies = await loadFirefoxCookies(options);
  return [...chromiumCookies, ...firefoxCookies];
}

export async function loadSessionsFromOktaCli(
  baseUrl: string,
  options: AuthOptions = {},
  forceLogin = false,
): Promise<MoodleSessionCookie[]> {
  const execFile = options.execFile ?? defaultExecFile;
  const executable = await findExecutable("okta", execFile, options.platform);
  if (!executable) {
    return [];
  }

  const stored = await readOktaCookies(executable, baseUrl, execFile);
  if ((stored.length && !forceLogin) || options.nonInteractive) {
    return stored;
  }

  const login = await runOktaJson(executable, ["login", baseUrl], execFile);
  if (!login) {
    return stored;
  }
  const refreshed = await readOktaCookies(executable, baseUrl, execFile);
  return refreshed.length ? refreshed : stored;
}

export function authFailureHint(baseUrl: string): string {
  return [
    `Log in to ${loginUrl(baseUrl)} in your browser, then rerun the command.`,
    `Or set ${ENV_MOODLE_SESSION} to a valid MoodleSession cookie value.`,
    `For automatic login, install okta-auth: ${OKTA_AUTH_INSTALL_COMMAND}, then run ${OKTA_AUTH_CONFIG_COMMAND}.`,
    `okta-auth: ${OKTA_AUTH_URL}`,
  ].join("\n");
}

export async function invalidateCachedSession(baseUrl: string, options: AuthOptions = {}): Promise<void> {
  await deleteCachedSession(baseUrl, cacheOptions(options));
}

export function parseSessionContext(html: string): SessionValidation | null {
  const sesskey = firstMatch(html, [
    /"sesskey"\s*:\s*"([^"]+)"/,
    /\bsesskey\s*:\s*'([^']+)'/,
    /name=["']sesskey["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']sesskey["']/i,
  ]);
  if (!sesskey) {
    return null;
  }

  const useridRaw = firstMatch(html, [
    /"userid"\s*:\s*(\d+)/,
    /\buserid\s*:\s*(\d+)/,
    /data-userid=["'](\d+)["']/i,
  ]);

  return { sesskey: decodeHtml(sesskey), userid: useridRaw ? Number(useridRaw) : 0 };
}

function validateSessionWithFetch(options: AuthOptions): SessionValidator {
  return async (baseUrl: string, cookie: MoodleSessionCookie): Promise<SessionValidation | null> => {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) {
      throw new AuthError("fetch is not available in this runtime.", authFailureHint(baseUrl));
    }

    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${DASHBOARD_PATH}`, {
        redirect: "follow",
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
    } catch {
      return null;
    }

    if (response.status >= 400 || isLoginRedirect(response.url, baseUrl)) {
      return null;
    }

    const html = await response.text();
    if (looksLikeLoginPage(html)) {
      return null;
    }
    return parseSessionContext(html);
  };
}

async function loadChromiumCookies(baseUrl: string, options: AuthOptions): Promise<MoodleSessionCookie[]> {
  const chrome = await importChromeCookiesSecure();
  if (!chrome) {
    return [];
  }

  const cookies: MoodleSessionCookie[] = [];
  for (const browser of ["Chrome", "Brave", "Edge"] as const) {
    for (const cookieFile of await chromiumCookieFiles(browser, options)) {
      try {
        const items = await chrome.getCookiesPromised(baseUrl, "puppeteer", cookieFile);
        cookies.push(
          ...items.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            source: `${browser}:${basename(cookieFile)}`,
          })),
        );
      } catch {
        continue;
      }
    }
  }
  return cookies;
}

async function loadFirefoxCookies(options: AuthOptions): Promise<MoodleSessionCookie[]> {
  const execFile = options.execFile ?? defaultExecFile;
  const sqlite = await findExecutable("sqlite3", execFile, options.platform);
  if (!sqlite) {
    return [];
  }

  const cookies: MoodleSessionCookie[] = [];
  for (const cookieFile of await firefoxCookieFiles(options)) {
    const tempDir = await mkdtemp(join(tmpdir(), "moodle-cli-firefox-"));
    const tempDb = join(tempDir, "cookies.sqlite");
    try {
      await copyFile(cookieFile, tempDb);
      const result = await execFile(sqlite, [
        "-json",
        tempDb,
        "select name, value, host as domain, path from moz_cookies where name like 'MoodleSession%';",
      ]);
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        continue;
      }
      const rows = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(rows)) {
        continue;
      }
      cookies.push(
        ...rows.filter(isRecord).map((row) => ({
          name: String(row.name ?? ""),
          value: String(row.value ?? ""),
          domain: typeof row.domain === "string" ? row.domain : undefined,
          path: typeof row.path === "string" ? row.path : undefined,
          source: `Firefox:${basename(cookieFile)}`,
        })),
      );
    } catch {
      continue;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  return cookies;
}

async function chromiumCookieFiles(
  browser: "Chrome" | "Brave" | "Edge",
  options: AuthOptions,
): Promise<string[]> {
  const files: string[] = [];
  for (const root of chromiumUserDataDirs(browser, options)) {
    const profiles = await profileDirs(root);
    for (const profile of profiles) {
      for (const relative of ["Cookies", "Network/Cookies"]) {
        const file = join(root, profile, relative);
        if (await isFile(file)) {
          files.push(file);
        }
      }
    }
  }
  return files;
}

function chromiumUserDataDirs(browser: "Chrome" | "Brave" | "Edge", options: AuthOptions): string[] {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const dirs = {
    darwin: {
      Chrome: ["Library/Application Support/Google/Chrome"],
      Brave: ["Library/Application Support/BraveSoftware/Brave-Browser"],
      Edge: ["Library/Application Support/Microsoft Edge"],
    },
    linux: {
      Chrome: [".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"],
      Brave: [".config/BraveSoftware/Brave-Browser", ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"],
      Edge: [".config/microsoft-edge"],
    },
    win32: {
      Chrome: ["AppData/Local/Google/Chrome/User Data"],
      Brave: ["AppData/Local/BraveSoftware/Brave-Browser/User Data"],
      Edge: ["AppData/Local/Microsoft/Edge/User Data"],
    },
  } as const;

  return [...(dirs[platform as keyof typeof dirs]?.[browser] ?? [])].map((part) => join(home, part));
}

async function firefoxCookieFiles(options: AuthOptions): Promise<string[]> {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const roots = {
    darwin: ["Library/Application Support/Firefox/Profiles"],
    linux: [".mozilla/firefox"],
    win32: ["AppData/Roaming/Mozilla/Firefox/Profiles"],
  } as const;

  const files: string[] = [];
  for (const rootPart of roots[platform as keyof typeof roots] ?? []) {
    const root = join(home, rootPart);
    for (const profile of await profileDirs(root, true)) {
      const file = join(root, profile, "cookies.sqlite");
      if (await isFile(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

async function profileDirs(root: string, allowAnyDirectory = false): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => allowAnyDirectory || name === "Default" || name === "Guest Profile" || name.startsWith("Profile "));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function importChromeCookiesSecure(): Promise<ChromeCookiesSecure | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const module = (await dynamicImport("chrome-cookies-secure")) as { default?: ChromeCookiesSecure } & ChromeCookiesSecure;
    return (module.default ?? module) as ChromeCookiesSecure;
  } catch {
    return null;
  }
}

async function readOktaCookies(
  executable: string,
  baseUrl: string,
  execFile: ExecFile,
): Promise<MoodleSessionCookie[]> {
  const payload = await runOktaJson(executable, ["cookies", baseUrl], execFile);
  if (!payload) {
    return [];
  }

  const cookies = Array.isArray(payload.cookies) ? payload.cookies : Array.isArray(payload) ? payload : [];
  return cookies.filter(isRecord).map((cookie) => ({
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: typeof cookie.domain === "string" ? cookie.domain : undefined,
    path: typeof cookie.path === "string" ? cookie.path : undefined,
    source: "okta",
  }));
}

async function runOktaJson(
  executable: string,
  args: string[],
  execFile: ExecFile,
): Promise<Record<string, unknown> | null> {
  const result = await execFile(executable, [...args, "--json"]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function findExecutable(
  name: string,
  execFile: ExecFile,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const command = platform === "win32" ? "where" : "which";
  const result = await execFile(command, [name]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.split(/\r?\n/, 1)[0]?.trim() || null;
}

async function firstValidSession(
  baseUrl: string,
  cookies: MoodleSessionCookie[],
  validate: SessionValidator,
): Promise<{ cookie: MoodleSessionCookie; context: SessionValidation } | null> {
  for (const cookie of cookies) {
    const context = await validate(baseUrl, cookie);
    if (context) {
      return { cookie, context };
    }
  }
  return null;
}

async function readCache(baseUrl: string, options: AuthOptions): Promise<AuthenticatedSession | null> {
  try {
    const cached = await readCachedSession(baseUrl, cacheOptions(options));
    return cached ? cachedSessionToAuth(baseUrl, cached) : null;
  } catch {
    return null;
  }
}

async function refreshSessionCache(
  baseUrl: string,
  cookie: MoodleSessionCookie,
  context: SessionValidation,
  options: AuthOptions,
): Promise<void> {
  const session: CachedSession = {
    baseUrl,
    cookieName: cookie.name,
    cookieValue: cookie.value,
    sesskey: context.sesskey,
    userid: context.userid,
    savedAt: (options.now ?? Date.now)(),
  };
  try {
    await writeCachedSession(session, cacheOptions(options));
  } catch {
    return;
  }
}

function cachedSessionToAuth(baseUrl: string, cached: CachedSession): AuthenticatedSession {
  return {
    baseUrl,
    cookie: { name: cached.cookieName, value: cached.cookieValue, source: "cache" },
    sesskey: cached.sesskey,
    userid: cached.userid,
    fromCache: true,
  };
}

function cacheOptions(options: AuthOptions) {
  return {
    homeDir: options.homeDir,
    ttlMs: options.cacheTtlMs,
    now: options.now,
    noCache: options.noCache,
  };
}

function cookieHostRank(domain: string | undefined, host: string): number | null {
  if (!domain) {
    return 2;
  }
  const normalized = domain.replace(/^\./, "").toLowerCase();
  if (normalized === host) {
    return 0;
  }
  if (host.endsWith(`.${normalized}`)) {
    return 1;
  }
  return null;
}

function loginUrl(baseUrl: string): string {
  return new URL(LOGIN_PATH, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function isLoginRedirect(responseUrl: string, baseUrl: string): boolean {
  if (!responseUrl) {
    return false;
  }
  const path = new URL(responseUrl, baseUrl).pathname;
  return path === LOGIN_PATH || path.startsWith("/login/");
}

function looksLikeLoginPage(html: string): boolean {
  return /name=["']username["']/i.test(html) && /name=["']password["']/i.test(html);
}

function firstMatch(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const defaultExecFile: ExecFile = (file: string, args: string[]) =>
  new Promise((resolve) => {
    execFileCallback(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const errorWithCode = error as (Error & { code?: number | string }) | null;
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: errorWithCode ? Number(errorWithCode.code) || 1 : 0,
      });
    });
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
