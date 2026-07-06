import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CACHE_DIR_NAME,
  DEFAULT_SESSION_CACHE_TTL_MS,
  SESSION_CACHE_FILENAME,
} from "./constants.js";

export interface CachedSession {
  baseUrl: string;
  cookieName: string;
  cookieValue: string;
  sesskey: string;
  userid: number;
  savedAt: number;
}

export interface SessionCacheOptions {
  homeDir?: string;
  ttlMs?: number;
  now?: () => number;
  noCache?: boolean;
  fs?: SessionCacheFs;
}

export interface SessionCacheFs {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  rm: typeof rm;
  chmod: typeof chmod;
}

const nodeFs: SessionCacheFs = { readFile, writeFile, mkdir, rm, chmod };

export function sessionCachePath(homeDir = homedir()): string {
  return join(homeDir, CACHE_DIR_NAME, SESSION_CACHE_FILENAME);
}

export function isCachedSessionFresh(
  session: CachedSession,
  ttlMs = DEFAULT_SESSION_CACHE_TTL_MS,
  now = Date.now,
): boolean {
  const age = now() - session.savedAt;
  return age >= 0 && age <= ttlMs;
}

export async function readCachedSession(
  baseUrl: string,
  options: SessionCacheOptions = {},
): Promise<CachedSession | null> {
  if (options.noCache) {
    return null;
  }

  const fs = options.fs ?? nodeFs;
  const path = sessionCachePath(options.homeDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  const session = parseCachedSession(raw);
  if (!session || !sameBaseUrl(session.baseUrl, baseUrl)) {
    return null;
  }

  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_CACHE_TTL_MS;
  return isCachedSessionFresh(session, ttlMs, options.now ?? Date.now) ? session : null;
}

export async function writeCachedSession(
  session: CachedSession,
  options: SessionCacheOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const path = sessionCachePath(options.homeDir);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(path, 0o600);
}

export async function deleteCachedSession(
  baseUrl: string,
  options: SessionCacheOptions = {},
): Promise<void> {
  const current = await readCachedSession(baseUrl, { ...options, noCache: false, ttlMs: Number.MAX_SAFE_INTEGER });
  if (!current) {
    return;
  }

  const fs = options.fs ?? nodeFs;
  try {
    await fs.rm(sessionCachePath(options.homeDir), { force: true });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function parseCachedSession(raw: string): CachedSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const session = value as Partial<CachedSession>;
  if (
    typeof session.baseUrl !== "string" ||
    typeof session.cookieName !== "string" ||
    typeof session.cookieValue !== "string" ||
    typeof session.sesskey !== "string" ||
    typeof session.userid !== "number" ||
    typeof session.savedAt !== "number"
  ) {
    return null;
  }

  return {
    baseUrl: session.baseUrl,
    cookieName: session.cookieName,
    cookieValue: session.cookieValue,
    sesskey: session.sesskey,
    userid: session.userid,
    savedAt: session.savedAt,
  };
}

function sameBaseUrl(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left === right;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
