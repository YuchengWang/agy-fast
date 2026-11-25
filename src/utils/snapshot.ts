import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execBinaryAsync, withNonInteractiveGitEnv } from "./exec-utils.js";
import { DEFAULT_IGNORE_DIRS } from "./fs-utils.js";
import { sliceSafeChars, sliceUtf8Bytes, truncateWithByteNotice } from "./output-filter.js";

export const DEFAULT_SCAN_TIMEOUT_MS = 250;

export interface SnapshotOptions {
  maxChars?: number;
  maxBytes?: number;
  gitTimeoutMs?: number;
  scanTimeoutMs?: number;
  gitExec?: typeof execBinaryAsync;
}

const HARDENED_GIT_BASE_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "diff.external=",
  "-c",
  "gpg.program=false",
  "-c",
  "gpg.openpgp.program=false",
  "-c",
  "gpg.ssh.program=false",
  "-c",
  "gpg.x509.program=false",
  "--no-pager",
] as const;

async function findGitEntry(workspaceDir: string): Promise<string | null> {
  let cur = path.resolve(workspaceDir);
  while (true) {
    const candidate = path.join(cur, ".git");
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

async function readBranchFromGitEntry(gitEntry: string | null): Promise<string | null> {
  if (!gitEntry) return null;
  try {
    const st = await fs.stat(gitEntry);
    let gitDir = gitEntry;
    if (st.isFile()) {
      const ptr = await fs.readFile(gitEntry, "utf8");
      const m = /^gitdir:\s*(.+)$/im.exec(ptr.trim());
      if (!m?.[1]) return null;
      gitDir = path.resolve(path.dirname(gitEntry), m[1].trim());
    }
    const headRaw = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(headRaw);
    return refMatch?.[1]?.trim() || "HEAD";
  } catch {
    return null;
  }
}

export function parsePorcelainBranchHeader(headerLine: string): {
  branch: string;
  isUnborn: boolean;
} {
  const body = headerLine.slice(3).trim();
  const unbornMatch = /^(?:No commits yet|Initial commit) on (.+)$/.exec(body);
  if (unbornMatch?.[1]) {
    const branchOnly = unbornMatch[1].split("...")[0]?.trim() || "HEAD";
    return { branch: branchOnly, isUnborn: true };
  }
  if (/^HEAD\s*\(no branch\)$/i.test(body)) {
    return { branch: "HEAD", isUnborn: false };
  }
  // Strip optional upstream tracking suffix `...origin/main [ahead 1]`
  const branchOnly = body.split("...")[0]?.trim() || "HEAD";
  return { branch: branchOnly, isUnborn: false };
}

async function getGitSummary(
  workspaceDir: string,
  timeoutMs: number,
  gitExec: typeof execBinaryAsync = execBinaryAsync,
): Promise<string | null> {
  const hasExplicitGitEnv = Boolean(process.env.GIT_DIR || process.env.GIT_WORK_TREE);
  const gitEntry = hasExplicitGitEnv ? null : await findGitEntry(workspaceDir);
  if (!hasExplicitGitEnv && !gitEntry) {
    return null;
  }

  const gitEnv = withNonInteractiveGitEnv();
  const [statusRes, logRes] = await Promise.all([
    gitExec(
      "git",
      [...HARDENED_GIT_BASE_ARGS, "status", "--porcelain=v1", "--branch"],
      {
        cwd: workspaceDir,
        timeoutMs,
        maxOutputBytes: 32_768,
        env: gitEnv,
      },
    ),
    gitExec("git", [...HARDENED_GIT_BASE_ARGS, "log", "-n", "3", "--format=%h %s"], {
      cwd: workspaceDir,
      timeoutMs,
      maxOutputBytes: 8192,
      env: gitEnv,
    }),
  ]);

  const statusOk = !statusRes.error && !statusRes.timedOut && statusRes.exitCode === 0;
  const logOk = !logRes.error && !logRes.timedOut && logRes.exitCode === 0;
  const fallbackBranch =
    !statusOk && gitEntry ? await readBranchFromGitEntry(gitEntry) : null;

  if (!statusOk && !logOk && !(statusRes.timedOut && fallbackBranch)) {
    return null;
  }

  let branch = "HEAD";
  let isUnborn = false;
  let statusLines: string[] = [];

  if (statusOk) {
    const rawLines = statusRes.stdout.split(/\r?\n/);
    if (statusRes.truncated && rawLines.length > 1) {
      // Drop potentially mid-path truncated trailing line
      rawLines.pop();
    }
    const headerIdx = rawLines.findIndex((l) => l.startsWith("## "));
    if (headerIdx !== -1) {
      const parsed = parsePorcelainBranchHeader(rawLines[headerIdx]!);
      branch = parsed.branch;
      isUnborn = parsed.isUnborn;
      rawLines.splice(headerIdx, 1);
    } else {
      branch = (await readBranchFromGitEntry(gitEntry)) ?? "HEAD";
    }
    statusLines = rawLines.filter((l) => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("?? ")) {
        const rawPath = trimmed.slice(3).replace(/^"/, "");
        const topSeg = rawPath.split("/")[0]?.replace(/\/$/, "");
        if (topSeg && DEFAULT_IGNORE_DIRS.has(topSeg)) return false;
      }
      return true;
    });
  } else {
    branch = fallbackBranch ?? "HEAD";
  }

  const logLines = logOk
    ? logRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  const parts: string[] = [
    isUnborn ? `Git: branch \`${branch}\` (unborn, no commits yet)` : `Git: branch \`${branch}\``,
  ];
  if (!statusOk) {
    parts.push(
      statusRes.timedOut
        ? "Working tree: unknown (git status timed out)"
        : "Working tree: unknown (git status failed)",
    );
  } else if (statusLines.length === 0) {
    parts.push("Working tree: clean");
  } else {
    const countLabel = statusRes.truncated ? `${statusLines.length}+` : `${statusLines.length}`;
    const prefix = `Modified (${countLabel}): `;
    const maxModifiedChars = 260;
    const maxItems = 8;
    const shown: string[] = [];
    let currentLen = prefix.length;
    for (let i = 0; i < Math.min(statusLines.length, maxItems); i++) {
      const raw = statusLines[i]!.trim();
      const item = raw.length > 100 ? `${sliceSafeChars(raw, 97)}...` : raw;
      const sepLen = shown.length > 0 ? 2 : 0;
      const remainingAfter = statusLines.length - (i + 1);
      const moreReserve =
        remainingAfter > 0 || statusRes.truncated ? ` (+${remainingAfter} more)`.length : 0;
      if (shown.length > 0 && currentLen + sepLen + item.length + moreReserve > maxModifiedChars) {
        break;
      }
      shown.push(item);
      currentLen += sepLen + item.length;
    }
    const more =
      shown.length < statusLines.length
        ? ` (+${statusLines.length - shown.length}${statusRes.truncated ? "+" : ""} more)`
        : statusRes.truncated
          ? " (+more)"
          : "";
    parts.push(`${prefix}${shown.join(", ")}${more}`);
  }
  if (logLines.length > 0) {
    parts.push(
      `Recent commits:\n${logLines.map((l) => `  - ${sliceSafeChars(l, 72)}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

const SNAPSHOT_COLLAPSE_DIRS = new Set([
  "tmp",
  "temp",
  "output",
  "outputs",
  "artifacts",
  "ssl",
  "SSL",
  "playwright-report",
  "test-results",
  "coverage",
  "logs",
]);

const SNAPSHOT_PRIORITY_SUBDIRS = new Set([
  "src",
  "app",
  "lib",
  "packages",
  "server",
  "web",
  "client",
  "api",
  "tests",
  "test",
  "scripts",
]);

const SNAPSHOT_ALWAYS_SKIP_DIRS = new Set([
  "appdata",
  "application data",
  "application support",
  "local settings",
  "program files",
  "program files (x86)",
  "programdata",
  "$recycle.bin",
  "system volume information",
  "onedrive",
  "icloud drive",
  "mobile documents",
  "creative cloud files",
  "msocache",
  "perflogs",
  "system32",
  "syswow64",
  "winsxs",
]);

const SNAPSHOT_HOME_ROOT_SKIP_DIRS = new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "photos",
  "movies",
  "videos",
  "music",
  "library",
  "applications",
  "public",
  "favorites",
  "contacts",
  "links",
  "saved games",
  "searches",
  "3d objects",
  "my documents",
  "my music",
  "my pictures",
  "my videos",
  "nethood",
  "printhood",
  "recent",
  "sendto",
  "start menu",
  "templates",
  "cookies",
  "documents and settings",
  "all users",
  "default user",
  "recovery",
  "windows",
  "users",
  "intel",
  "dropbox",
  "google drive",
  "parallels",
  "virtualbox vms",
  "trash",
  "proc",
  "sys",
  "dev",
  "mnt",
  "media",
  "run",
  "volumes",
  "private",
  "system",
]);

const DEFAULT_IGNORE_DIRS_LOWER = new Set(
  [...DEFAULT_IGNORE_DIRS].map((d) => d.toLowerCase()),
);

const SNAPSHOT_COLLAPSE_DIRS_LOWER = new Set(
  [...SNAPSHOT_COLLAPSE_DIRS].map((d) => d.toLowerCase()),
);

const SNAPSHOT_SKIP_FILES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
  "ntuser.dat",
  "ntuser.ini",
]);

function isSystemUserParentPath(p: string): boolean {
  const lowerPosix = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return (
    lowerPosix === "/users" ||
    lowerPosix === "/home" ||
    /^[a-z]:\/users$/i.test(lowerPosix) ||
    /^[a-z]:\/documents and settings$/i.test(lowerPosix)
  );
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  const root = path.parse(resolved).root;
  const trimmed =
    resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return process.platform === "win32" || process.platform === "darwin"
    ? trimmed.toLowerCase()
    : trimmed;
}

async function boundedRealpath(p: string, deadlineMs?: number): Promise<string> {
  if (deadlineMs === undefined) {
    return fs.realpath(p).catch(() => p);
  }
  const res = await raceWithDeadline(fs.realpath(p), deadlineMs);
  return res.ok ? res.value : p;
}

export async function isHomeOrSystemRoot(
  workspaceDir: string,
  deadlineMs?: number,
): Promise<boolean> {
  const resolved = path.resolve(workspaceDir);
  if (path.parse(resolved).root === resolved) return true;
  if (isSystemUserParentPath(resolved)) return true;

  const homeCandidates = new Set<string>();
  for (const cand of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (cand && cand.trim()) {
      homeCandidates.add(path.resolve(cand.trim()));
    }
  }
  const resolvedKey = normalizePathForCompare(resolved);
  for (const cand of homeCandidates) {
    if (normalizePathForCompare(cand) === resolvedKey) return true;
  }

  const candList = [...homeCandidates];
  const [realWorkspace, ...realCands] = await Promise.all([
    boundedRealpath(resolved, deadlineMs),
    ...candList.map((cand) => boundedRealpath(cand, deadlineMs)),
  ]);
  if (path.parse(realWorkspace).root === realWorkspace) return true;
  if (isSystemUserParentPath(realWorkspace)) return true;

  const wsKeys = new Set([resolvedKey, normalizePathForCompare(realWorkspace)]);
  for (const realCand of realCands) {
    if (wsKeys.has(normalizePathForCompare(realCand))) return true;
  }
  return false;
}

function isAlwaysSkippedDirName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SNAPSHOT_ALWAYS_SKIP_DIRS.has(lower) ||
    lower.startsWith("onedrive - ") ||
    lower.startsWith("$recycle")
  );
}

function isSkippedMetadataFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SNAPSHOT_SKIP_FILES.has(lower) || lower.startsWith("ntuser.dat");
}

function shouldSkipSnapshotEntry(
  name: string,
  isDir: boolean,
  isSymlink: boolean,
  isHomeRoot: boolean,
): boolean {
  const lower = name.toLowerCase();
  if (isSkippedMetadataFile(name)) {
    return true;
  }
  if (isDir || isSymlink) {
    if (isAlwaysSkippedDirName(name)) return true;
    if (isHomeRoot && SNAPSHOT_HOME_ROOT_SKIP_DIRS.has(lower)) return true;
  }
  if (isDir) {
    if (name.startsWith(".")) return true;
    if (DEFAULT_IGNORE_DIRS_LOWER.has(lower)) return true;
  }
  return false;
}

const TIMEOUT_SENTINEL = Symbol("snapshot-timeout");

async function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean }> {
  const remaining = deadlineMs - performance.now();
  if (remaining <= 0) {
    void promise.catch(() => {});
    return { ok: false, timedOut: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), remaining);
  });
  try {
    const res = await Promise.race([promise, timeoutPromise]);
    if (res === TIMEOUT_SENTINEL) {
      void promise.catch(() => {});
      return { ok: false, timedOut: true };
    }
    return { ok: true, value: res };
  } catch {
    return { ok: false, timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isIgnoredSnapshotSubdir(name: string): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith(".") || DEFAULT_IGNORE_DIRS_LOWER.has(lower)) return true;
  if (isAlwaysSkippedDirName(name)) return true;
  if (
    lower === "playwright-report" ||
    lower === "test-results" ||
    lower.startsWith("dist-") ||
    lower.startsWith("build-")
  ) {
    return true;
  }
  return false;
}

const MANIFEST_SKIP_SUBDIRS_LOWER = new Set(
  [
    "docs",
    "doc",
    "assets",
    "scripts",
    "test",
    "tests",
    "fixtures",
    "examples",
    ...SNAPSHOT_COLLAPSE_DIRS,
  ].map((d) => d.toLowerCase()),
);

function shortEntryName(name: string, maxLen = 28): string {
  return name.length > maxLen ? `${sliceSafeChars(name, maxLen - 3)}...` : name;
}

async function getTwoLevelTree(
  workspaceDir: string,
  topRes: { ok: true; value: Dirent[] } | { ok: false; timedOut: boolean },
  isHomeRoot: boolean,
  deadlineMs: number,
): Promise<string | null> {
  if (!topRes.ok) {
    return topRes.timedOut
      ? "Layout (2 levels):\n  ... (scan timed out)"
      : null;
  }
  const topEntries = topRes.value;

  const filteredTop = topEntries
    .filter(
      (e) =>
        !shouldSkipSnapshotEntry(
          e.name,
          e.isDirectory(),
          e.isSymbolicLink(),
          isHomeRoot,
        ),
    )
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      const aCollapse =
        a.isDirectory() && SNAPSHOT_COLLAPSE_DIRS_LOWER.has(a.name.toLowerCase());
      const bCollapse =
        b.isDirectory() && SNAPSHOT_COLLAPSE_DIRS_LOWER.has(b.name.toLowerCase());
      if (aCollapse !== bCollapse) return aCollapse ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  if (filteredTop.length === 0) return null;

  const lines: string[] = [];
  const maxTop = 20;
  const shownTop = filteredTop.slice(0, maxTop);

  // Never fan out depth-2 readdir calls on $HOME or filesystem roots (e.g. C:\Users\<user>);
  // a 1-level listing avoids 20+ slow OS/NTFS directory scans and scan timeouts on startup.
  if (isHomeRoot) {
    for (const entry of shownTop) {
      lines.push(
        entry.isDirectory()
          ? `  ${entry.name}/`
          : `  ${shortEntryName(entry.name)}`,
      );
    }
    if (filteredTop.length > maxTop) {
      lines.push(`  ... (+${filteredTop.length - maxTop} more top-level entries)`);
    }
    return `Layout (1 level):\n${lines.join("\n")}`;
  }

  const subResults = new Array<{
    name: string;
    isDir: boolean;
    collapsedCount: number | null;
    children: string[];
    more: number;
    timedOut: boolean;
  }>(shownTop.length);

  let nextIdx = 0;
  const workerCount = Math.min(4, shownTop.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= shownTop.length) break;
        const entry = shownTop[idx]!;
        if (!entry.isDirectory()) {
          subResults[idx] = {
            name: shortEntryName(entry.name),
            isDir: false,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: false,
          };
          continue;
        }
        if (performance.now() >= deadlineMs) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: true,
          };
          continue;
        }
        const subRes = await raceWithDeadline(
          fs.readdir(path.join(workspaceDir, entry.name), {
            withFileTypes: true,
          }),
          deadlineMs,
        );
        if (!subRes.ok) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: null,
            children: [],
            more: 0,
            timedOut: subRes.timedOut,
          };
          continue;
        }
        const valid = subRes.value
          .filter(
            (s) =>
              !isSkippedMetadataFile(s.name) &&
              !(s.isDirectory() && isIgnoredSnapshotSubdir(s.name)) &&
              !(s.isSymbolicLink() && isAlwaysSkippedDirName(s.name)),
          )
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            if (a.isDirectory() && b.isDirectory()) {
              const aPrio = SNAPSHOT_PRIORITY_SUBDIRS.has(a.name);
              const bPrio = SNAPSHOT_PRIORITY_SUBDIRS.has(b.name);
              if (aPrio !== bPrio) return aPrio ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });
        if (SNAPSHOT_COLLAPSE_DIRS_LOWER.has(entry.name.toLowerCase())) {
          subResults[idx] = {
            name: `${entry.name}/`,
            isDir: true,
            collapsedCount: valid.length,
            children: [],
            more: 0,
            timedOut: false,
          };
          continue;
        }
        const maxSub = 6;
        const children = valid.slice(0, maxSub).map((s) => {
          const base = shortEntryName(s.name);
          return s.isDirectory() ? `${base}/` : base;
        });
        subResults[idx] = {
          name: `${entry.name}/`,
          isDir: true,
          collapsedCount: null,
          children,
          more: Math.max(0, valid.length - maxSub),
          timedOut: false,
        };
      }
    }),
  );

  let timedOutDirs = 0;
  for (const item of subResults) {
    if (item.timedOut) timedOutDirs++;
    if (!item.isDir) {
      lines.push(`  ${item.name}`);
    } else if (item.collapsedCount !== null) {
      lines.push(`  ${item.name} (${item.collapsedCount} entries)`);
    } else if (item.children.length === 0) {
      lines.push(`  ${item.name}`);
    } else {
      const more = item.more > 0 ? `, +${item.more}` : "";
      lines.push(`  ${item.name} (${item.children.join(", ")}${more})`);
    }
  }

  if (filteredTop.length > maxTop) {
    lines.push(`  ... (+${filteredTop.length - maxTop} more top-level entries)`);
  }
  if (timedOutDirs > 0) {
    lines.push(
      `  ... (${timedOutDirs} dir${timedOutDirs === 1 ? "" : "s"} skipped; scan timed out)`,
    );
  }

  return `Layout (2 levels):\n${lines.join("\n")}`;
}

async function detectManifestsInDir(
  dirPath: string,
  prefix: string,
  knownFiles?: Set<string>,
): Promise<string[]> {
  const hints: string[] = [];
  const hasFile = (name: string): boolean => !knownFiles || knownFiles.has(name);

  await Promise.all([
    // package.json
    (async () => {
      if (!hasFile("package.json")) return;
      try {
        const raw = await fs.readFile(path.join(dirPath, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as {
          name?: unknown;
          scripts?: unknown;
        };
        const pkgName = typeof pkg.name === "string" ? pkg.name.trim() : "";
        const scriptNames =
          pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
            ? Object.keys(pkg.scripts as Record<string, unknown>).slice(0, 12)
            : [];
        const label = pkgName
          ? `${prefix}package.json (${pkgName})`
          : `${prefix}package.json`;
        hints.push(
          scriptNames.length > 0
            ? `${label} scripts: ${scriptNames.join(", ")}`
            : label,
        );
      } catch {
        // not present
      }
    })(),

    // Makefile (root only to avoid noisy nested Makefiles)
    (async () => {
      if (prefix) return;
      for (const name of ["Makefile", "makefile"]) {
        if (!hasFile(name)) continue;
        try {
          const raw = await fs.readFile(path.join(dirPath, name), "utf8");
          const targets: string[] = [];
          for (const line of raw.split(/\r?\n/)) {
            const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
            if (m && m[1] && !m[1].startsWith(".")) {
              if (!targets.includes(m[1])) targets.push(m[1]);
              if (targets.length >= 10) break;
            }
          }
          hints.push(
            targets.length > 0
              ? `${name} targets: ${targets.join(", ")}`
              : name,
          );
          break;
        } catch {
          // not present
        }
      }
    })(),

    // pom.xml (Maven)
    (async () => {
      if (!hasFile("pom.xml")) return;
      try {
        const raw = await fs.readFile(path.join(dirPath, "pom.xml"), "utf8");
        const stripped = raw.replace(/<parent>[\s\S]*?<\/parent>/i, "");
        const m = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/i.exec(stripped);
        hints.push(
          m?.[1] ? `${prefix}pom.xml (${m[1]}, maven)` : `${prefix}pom.xml (maven)`,
        );
      } catch {
        // not present
      }
    })(),

    // build.gradle / build.gradle.kts
    (async () => {
      for (const name of ["build.gradle.kts", "build.gradle"]) {
        if (!hasFile(name)) continue;
        try {
          await fs.access(path.join(dirPath, name));
          hints.push(`${prefix}${name} (gradle)`);
          break;
        } catch {
          // not present
        }
      }
    })(),

    // pyproject.toml
    (async () => {
      if (!hasFile("pyproject.toml")) return;
      try {
        const raw = await fs.readFile(path.join(dirPath, "pyproject.toml"), "utf8");
        const tools: string[] = [];
        if (/\[tool\.pytest/.test(raw)) tools.push("pytest");
        if (/\[tool\.ruff/.test(raw)) tools.push("ruff");
        if (/\[tool\.mypy/.test(raw)) tools.push("mypy");
        if (/\[tool\.poetry/.test(raw)) tools.push("poetry");
        if (/\[tool\.uv/.test(raw)) tools.push("uv");
        hints.push(
          tools.length > 0
            ? `${prefix}pyproject.toml (${tools.join(", ")})`
            : `${prefix}pyproject.toml`,
        );
      } catch {
        // not present
      }
    })(),

    // Cargo.toml
    (async () => {
      if (!hasFile("Cargo.toml")) return;
      try {
        const raw = await fs.readFile(path.join(dirPath, "Cargo.toml"), "utf8");
        const isWorkspace = /\[workspace\]/.test(raw);
        hints.push(
          isWorkspace ? `${prefix}Cargo.toml (workspace)` : `${prefix}Cargo.toml`,
        );
      } catch {
        // not present
      }
    })(),

    // go.mod
    (async () => {
      if (!hasFile("go.mod")) return;
      try {
        const raw = await fs.readFile(path.join(dirPath, "go.mod"), "utf8");
        const m = /^module\s+(\S+)/m.exec(raw);
        hints.push(m?.[1] ? `${prefix}go.mod (${m[1]})` : `${prefix}go.mod`);
      } catch {
        // not present
      }
    })(),
  ]);

  return hints;
}

const AUDIT_SCRIPT_NAME_RE =
  /(?:audit|redline|pre[-_]?commit|lint|check|verify)/i;
const AUDIT_SCRIPT_EXT_RE = /\.(?:py|sh|mjs|cjs|js|ts)$/i;

async function detectPluginAndAuditHints(
  workspaceDir: string,
  topRes: { ok: true; value: Dirent[] } | { ok: false; timedOut: boolean },
  isHomeRoot: boolean,
  deadlineMs: number,
): Promise<string[]> {
  if (isHomeRoot || !topRes.ok || performance.now() >= deadlineMs) {
    return [];
  }

  const hasAgentDir = topRes.value.some((e) => e.isDirectory() && e.name === ".agent");
  const hasScriptsDir = topRes.value.some((e) => e.isDirectory() && e.name === "scripts");

  const [pluginHint, auditHint] = await Promise.all([
    // Lightly detect project-level .agent/plugins/*/mcp_config.json
    (async (): Promise<string | null> => {
      if (!hasAgentDir || performance.now() >= deadlineMs) return null;
      const pluginsDir = path.join(workspaceDir, ".agent", "plugins");
      const pluginsRes = await raceWithDeadline(
        fs.readdir(pluginsDir, { withFileTypes: true }),
        deadlineMs,
      );
      if (!pluginsRes.ok) return null;
      const pluginDirs = pluginsRes.value
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 6);
      if (pluginDirs.length === 0) return null;

      const found: string[] = [];
      await Promise.all(
        pluginDirs.map(async (d) => {
          if (performance.now() >= deadlineMs) return;
          const cfgPath = path.join(pluginsDir, d.name, "mcp_config.json");
          const acc = await raceWithDeadline(fs.access(cfgPath), deadlineMs);
          if (acc.ok) {
            found.push(d.name);
          }
        }),
      );
      found.sort();
      if (found.length === 0) return null;
      return found.length === 1
        ? `.agent/plugins/${found[0]}/mcp_config.json`
        : `.agent/plugins MCP: ${found.join(", ")}`;
    })(),

    // Lightly detect common fast-audit scripts under scripts/ and scripts/{devops,ci}/
    (async (): Promise<string | null> => {
      if (!hasScriptsDir || performance.now() >= deadlineMs) return null;
      const scriptsDir = path.join(workspaceDir, "scripts");
      const scriptsRes = await raceWithDeadline(
        fs.readdir(scriptsDir, { withFileTypes: true }),
        deadlineMs,
      );
      if (!scriptsRes.ok) return null;

      const matched: string[] = [];
      const subAuditDirs: string[] = [];
      for (const entry of scriptsRes.value) {
        if (entry.isFile() && AUDIT_SCRIPT_NAME_RE.test(entry.name) && AUDIT_SCRIPT_EXT_RE.test(entry.name)) {
          matched.push(`scripts/${entry.name}`);
        } else if (entry.isDirectory() && (entry.name === "devops" || entry.name === "ci")) {
          subAuditDirs.push(entry.name);
        }
      }

      if (subAuditDirs.length > 0 && performance.now() < deadlineMs) {
        await Promise.all(
          subAuditDirs.map(async (sub) => {
            const subRes = await raceWithDeadline(
              fs.readdir(path.join(scriptsDir, sub), { withFileTypes: true }),
              deadlineMs,
            );
            if (!subRes.ok) return;
            for (const entry of subRes.value) {
              if (
                entry.isFile() &&
                AUDIT_SCRIPT_NAME_RE.test(entry.name) &&
                AUDIT_SCRIPT_EXT_RE.test(entry.name)
              ) {
                matched.push(`scripts/${sub}/${entry.name}`);
              }
            }
          }),
        );
      }

      matched.sort();
      if (matched.length === 0) return null;
      const shown = matched.slice(0, 4);
      const suffix = matched.length > 4 ? ` (+${matched.length - 4})` : "";
      return `Audit scripts: ${shown.join(", ")}${suffix}`;
    })(),
  ]);

  return [pluginHint, auditHint].filter((h): h is string => Boolean(h));
}

async function getProjectManifestSummary(
  workspaceDir: string,
  topRes: { ok: true; value: Dirent[] } | { ok: false; timedOut: boolean },
  isHomeRoot: boolean,
  deadlineMs: number,
): Promise<string | null> {
  const rootKnownFiles = topRes.ok
    ? new Set(topRes.value.filter((e) => !e.isDirectory()).map((e) => e.name))
    : undefined;
  const [rootRes, extraHints] = await Promise.all([
    raceWithDeadline(
      detectManifestsInDir(workspaceDir, "", rootKnownFiles),
      deadlineMs,
    ),
    detectPluginAndAuditHints(workspaceDir, topRes, isHomeRoot, deadlineMs),
  ]);
  const rootHints = rootRes.ok ? [...rootRes.value].sort() : [];
  const subHints: string[] = [];

  // Also inspect 1-level child subproject directories (e.g. server/, web/, desktop/, SourcingAgent/),
  // but never treat $HOME or a filesystem root as a monorepo (avoids up to 64 wasted manifest probes).
  if (!isHomeRoot && performance.now() < deadlineMs && topRes.ok) {
    const subdirs = topRes.value
      .filter(
        (e) =>
          e.isDirectory() &&
          !shouldSkipSnapshotEntry(e.name, true, false, isHomeRoot) &&
          !MANIFEST_SKIP_SUBDIRS_LOWER.has(e.name.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);

    let nextIdx = 0;
    const workerCount = Math.min(4, subdirs.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= subdirs.length || performance.now() >= deadlineMs) break;
          const d = subdirs[idx]!;
          const res = await raceWithDeadline(
            detectManifestsInDir(path.join(workspaceDir, d.name), `${d.name}/`),
            deadlineMs,
          );
          if (res.ok) {
            subHints.push(...res.value);
          }
        }
      }),
    );
  }

  subHints.sort();
  const allHints = [...rootHints, ...extraHints, ...subHints];
  if (allHints.length === 0) return null;
  return `Project:\n${allHints.slice(0, 6).map((h) => `  - ${h}`).join("\n")}`;
}

function fitSectionToChars(
  section: string,
  budget: number,
  marker: string,
): string {
  if (!Number.isFinite(budget) || budget <= 0) return "";
  const limit = Math.trunc(budget);
  if (limit <= 0) return "";
  if (section.length <= limit) return section;
  if (limit <= marker.length + 1) {
    return sliceSafeChars(section, limit);
  }
  const cutoff = limit - marker.length - 1;
  let trimmed = sliceSafeChars(section, cutoff);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > 0) {
    trimmed = trimmed.slice(0, lastNl);
  }
  return `${trimmed}\n${marker}`;
}

function fitSectionToBytes(
  section: string,
  budgetBytes: number,
  marker: string,
): string {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return "";
  const limit = Math.trunc(budgetBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(section, "utf8") <= limit) return section;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limit <= markerBytes + 1) {
    return sliceUtf8Bytes(section, limit);
  }
  const cutoffBytes = limit - markerBytes - 1;
  let trimmed = sliceUtf8Bytes(section, cutoffBytes);
  const lastNl = trimmed.lastIndexOf("\n");
  if (lastNl > 0) {
    trimmed = trimmed.slice(0, lastNl);
  }
  const result = `${trimmed}\n${marker}`;
  return Buffer.byteLength(result, "utf8") <= limit
    ? result
    : sliceUtf8Bytes(result, limit);
}

export async function buildWorkspaceSnapshot(
  workspaceDir: string,
  options: SnapshotOptions = {},
): Promise<string | null> {
  const maxChars =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
      ? Math.max(0, Math.trunc(options.maxChars))
      : 1500;
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.trunc(options.maxBytes))
      : maxChars;
  const gitTimeoutMs = options.gitTimeoutMs ?? 800;
  const scanTimeoutMs =
    typeof options.scanTimeoutMs === "number" && Number.isFinite(options.scanTimeoutMs)
      ? Math.max(1, Math.trunc(options.scanTimeoutMs))
      : DEFAULT_SCAN_TIMEOUT_MS;
  const scanDeadline = performance.now() + scanTimeoutMs;

  const statRes = await raceWithDeadline(fs.stat(workspaceDir), scanDeadline);
  if (!statRes.ok || !statRes.value.isDirectory()) return null;

  // Start git summary in parallel with home-root detection and shared root readdir
  const gitPromise = getGitSummary(workspaceDir, gitTimeoutMs, options.gitExec);
  const [isHomeRoot, topRes] = await Promise.all([
    isHomeOrSystemRoot(workspaceDir, scanDeadline),
    raceWithDeadline(
      fs.readdir(workspaceDir, { withFileTypes: true }),
      scanDeadline,
    ),
  ]);

  const [gitSummary, treeSummary, projectSummary] = await Promise.all([
    gitPromise,
    getTwoLevelTree(workspaceDir, topRes, isHomeRoot, scanDeadline),
    getProjectManifestSummary(workspaceDir, topRes, isHomeRoot, scanDeadline),
  ]);

  const header = `[agy-fast startup snapshot] Workspace: ${workspaceDir}`;
  const sections = [header, gitSummary, projectSummary, treeSummary].filter(
    (s): s is string => Boolean(s),
  );

  if (sections.length <= 1) return null;

  const full = sections.join("\n");
  if (full.length <= maxChars && Buffer.byteLength(full, "utf8") <= maxBytes) {
    return full;
  }

  const suffix = "... [snapshot capped]";
  const headerBytes = Buffer.byteLength(header, "utf8");
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxChars <= header.length + suffix.length + 4 || maxBytes <= headerBytes + suffixBytes + 4) {
    const charCapped = fitSectionToChars(full, maxChars, suffix);
    return Buffer.byteLength(charCapped, "utf8") <= maxBytes
      ? charCapped
      : truncateWithByteNotice(charCapped, maxBytes);
  }

  // Allocate per-section UTF-8 byte budgets so a large dirty git status or CJK paths
  // cannot erase Project or Layout while keeping total output <= maxBytes and <= maxChars.
  const remainingAfterHeader = maxBytes - headerBytes;
  const nonEmptyCount =
    (gitSummary ? 1 : 0) + (projectSummary ? 1 : 0) + (treeSummary ? 1 : 0);
  const availableForBodies = remainingAfterHeader - nonEmptyCount; // reserve \n separators

  let projectPart = "";
  let gitPart = "";
  let treePart = "";
  let budgetLeft = availableForBodies;

  if (projectSummary) {
    const otherPresent = Boolean(gitSummary || treeSummary);
    const projectBytes = Buffer.byteLength(projectSummary, "utf8");
    const projectCap = otherPresent
      ? Math.min(projectBytes, Math.max(80, Math.floor(availableForBodies * 0.25)))
      : budgetLeft;
    projectPart = fitSectionToBytes(
      projectSummary,
      Math.min(budgetLeft, projectCap),
      "  ... [project capped]",
    );
    budgetLeft -= Buffer.byteLength(projectPart, "utf8");
  }

  if (gitSummary && budgetLeft > 0) {
    const gitBytes = Buffer.byteLength(gitSummary, "utf8");
    const gitCap = treeSummary
      ? Math.min(gitBytes, Math.max(100, Math.floor(budgetLeft * 0.48)))
      : budgetLeft;
    gitPart = fitSectionToBytes(
      gitSummary,
      Math.min(budgetLeft, gitCap),
      "  ... [git capped]",
    );
    budgetLeft -= Buffer.byteLength(gitPart, "utf8");
  }

  if (treeSummary && budgetLeft > 0) {
    treePart = fitSectionToBytes(treeSummary, budgetLeft, suffix);
    budgetLeft -= Buffer.byteLength(treePart, "utf8");
  }

  let assembled = [header, gitPart, projectPart, treePart]
    .filter(Boolean)
    .join("\n");
  if (assembled.length > maxChars) {
    assembled = fitSectionToChars(assembled, maxChars, suffix);
  }
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    assembled = fitSectionToBytes(assembled, maxBytes, suffix);
  }
  return assembled;
}
