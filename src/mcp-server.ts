import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpStdioServer, type McpToolDefinition } from "./protocol/mcp.js";
import { MCP_CALL_BUDGET_SEC } from "./utils/exec-utils.js";
import {
  readSavedEditsFormatSync,
  resolveHostCompat,
  type EditsFormatMode,
  type ResolvedHostCompat,
} from "./utils/host-compat.js";
import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import { runBatchSearch, type BatchSearchInput } from "./tools/batch-search.js";
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";
import { runAgyFastCli } from "./cli-runner.js";

const SERVER_VERSION = "0.3.2";
const DEFAULT_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export interface AgyFastServerOptions {
  env?: NodeJS.ProcessEnv;
  configEditsFormat?: EditsFormatMode;
  processCwd?: () => string;
  pluginRoot?: string;
}

function canonicalizeDir(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  try {
    return typeof fs.realpathSync.native === "function"
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrSubdir(candidate: string, root: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  const normCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const normRoot = caseInsensitive ? root.toLowerCase() : root;
  const rel = path.relative(normRoot, normCandidate);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function isInstalledPluginPath(dirPath: string): boolean {
  const posix = dirPath.replace(/\\/g, "/");
  return /(?:^|\/)(?:\.gemini\/(?:config\/|antigravity[^/]*\/)?plugins|\.agents\/plugins)\/[^/]+(?:\/|$)/i.test(
    posix,
  );
}

function isSameDir(a: string, b: string): boolean {
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// A host that reports no MCP roots may start the server somewhere that is never a workspace:
// the filesystem root or the user's home directory itself. Resolving an omitted or relative
// `cwd` there writes files and runs commands outside any project, so ask for `cwd` instead.
function detectNonWorkspaceCwd(
  env: NodeJS.ProcessEnv,
  currentCwd: string,
): { dir: string; place: string } | null {
  const canonCwd = canonicalizeDir(currentCwd);
  if (path.parse(canonCwd).root === canonCwd) {
    return { dir: canonCwd, place: "the filesystem root" };
  }
  const isFullAbsPath = (p: string): boolean =>
    process.platform === "win32"
      ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(p)
      : path.isAbsolute(p);
  const driveHome =
    process.platform === "win32" &&
    typeof env.HOMEDRIVE === "string" &&
    typeof env.HOMEPATH === "string" &&
    env.HOMEDRIVE.trim() &&
    env.HOMEPATH.trim()
      ? `${env.HOMEDRIVE.trim()}${env.HOMEPATH.trim()}`
      : "";
  const homes = [env.HOME, env.USERPROFILE, driveHome]
    .map((h) => (typeof h === "string" ? h.trim() : ""))
    .filter((h) => h && isFullAbsPath(h));
  if (homes.length === 0 && env === process.env) {
    try {
      const osHome = os.homedir();
      if (isFullAbsPath(osHome)) homes.push(osHome);
    } catch {
      // No home directory to compare against
    }
  }
  for (const home of homes) {
    if (home && isSameDir(canonCwd, canonicalizeDir(home))) {
      return { dir: canonCwd, place: "the home directory" };
    }
  }
  return null;
}

function detectPluginInstallCwd(
  env: NodeJS.ProcessEnv,
  currentCwd: string,
  scriptPluginRoot: string,
): string | null {
  const canonCwd = canonicalizeDir(currentCwd);

  for (const envRoot of [env.PLUGIN_ROOT, env.AGY_PLUGIN_ROOT]) {
    if (typeof envRoot === "string" && envRoot.trim()) {
      const canonEnvRoot = canonicalizeDir(envRoot.trim());
      if (isSameOrSubdir(canonCwd, canonEnvRoot)) {
        return envRoot.trim();
      }
    }
  }

  const canonScriptRoot = canonicalizeDir(scriptPluginRoot);
  if (isSameOrSubdir(canonCwd, canonScriptRoot)) {
    const isRuntimeOnlyInstall =
      fs.existsSync(path.join(canonScriptRoot, "plugin.json")) &&
      !fs.existsSync(path.join(canonScriptRoot, "src", "mcp-server.ts"));
    if (isInstalledPluginPath(canonScriptRoot) || isRuntimeOnlyInstall) {
      return scriptPluginRoot;
    }
  }

  return null;
}

function buildApplyEditsToolDefinition(
  compat: ResolvedHostCompat,
): McpToolDefinition {
  const preferStringEdits = compat.editsFormat === "string";
  const editsSchema = preferStringEdits
    ? {
        type: "string",
        description:
          'JSON array string (1-50 files): [{"path","hunks"?:[{"target","replacement","startLine"?,"endLine"?,"replaceAll"?}],"create"?,"overwrite"?}]. Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create. Native arrays also work, but call_mcp_tool can turn long ones into [].',
      }
    : {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            hunks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  replacement: { type: "string" },
                  startLine: { type: "integer", minimum: 1 },
                  endLine: { type: "integer", minimum: 1 },
                  replaceAll: { type: "boolean" },
                },
                required: ["target", "replacement"],
              },
            },
            create: { type: "string" },
            overwrite: { type: "boolean" },
          },
          required: ["path"],
        },
      };

  const baseDesc = `Atomic multi-file edits. bestEffort writes valid files atomically per file, gives closest lines, skips verify on failure. dryRun=false (true validates only). verify shell in cwd after writes (60s/4000 chars default, agy drops at 180s). 8800 UTF-8 bytes total. Absolute cwd if no roots/list (Desktop 2.0 Hub).`;

  return {
    name: "apply_edits",
    description: preferStringEdits
      ? baseDesc
      : `${baseDesc} Exact target in 1-based window (all if replaceAll). Nonempty hunks XOR full-file create. overwrite allows replacing via create.`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        edits: editsSchema,
        dryRun: { type: "boolean" },
        bestEffort: { type: "boolean" },
        verify: { type: "string" },
        verifyTimeoutSec: {
          type: "integer",
          minimum: 1,
          maximum: MCP_CALL_BUDGET_SEC,
        },
        maxVerifyChars: {
          type: "integer",
          minimum: 300,
          maximum: 7500,
        },
      },
      required: ["edits"],
    },
  };
}

export function createAgyFastServer(
  options: AgyFastServerOptions = {},
): McpStdioServer {
  const env = options.env ?? process.env;
  const getProcessCwd = options.processCwd ?? (() => process.cwd());
  const scriptPluginRoot = options.pluginRoot ?? DEFAULT_PLUGIN_ROOT;
  const savedEditsFormat =
    options.configEditsFormat ?? readSavedEditsFormatSync(env);
  let hostCompat = resolveHostCompat({
    env,
    configEditsFormat: savedEditsFormat,
  });

  // agy starts plugin servers in the plugin directory; resolve omitted or relative
  // tool `cwd` values against the first valid workspace root without mutating process.cwd().
  // Never silently fall back to the installed plugin directory, the filesystem root or the
  // home directory when roots/list is unavailable.
  let defaultCwd: string | undefined;

  const resolveToolArgs = <T extends { cwd?: string }>(
    args: Record<string, unknown>,
  ): { ok: true; value: T } | { ok: false; error: string } => {
    if (args.cwd !== undefined && args.cwd !== null && typeof args.cwd !== "string") {
      return {
        ok: false,
        error: `Error: 'cwd' must be a string path (received ${Array.isArray(args.cwd) ? "array" : typeof args.cwd}).`,
      };
    }
    const rawCwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const isHomePath =
      rawCwd === "~" || rawCwd.startsWith("~/") || rawCwd.startsWith("~\\");
    if (!rawCwd) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: defaultCwd } as unknown as T,
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot,
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Pass the active workspace root explicitly in 'cwd'.`,
        };
      }
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' is required because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Pass the active workspace root explicitly in 'cwd'.`,
        };
      }
      return {
        ok: true,
        value: { ...args, cwd: undefined } as unknown as T,
      };
    }
    if (!path.isAbsolute(rawCwd) && !isHomePath) {
      if (defaultCwd) {
        return {
          ok: true,
          value: { ...args, cwd: path.resolve(defaultCwd, rawCwd) } as unknown as T,
        };
      }
      const pluginFallbackDir = detectPluginInstallCwd(
        env,
        getProcessCwd(),
        scriptPluginRoot,
      );
      if (pluginFallbackDir) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started inside the plugin directory (${pluginFallbackDir}). Received relative cwd: ${JSON.stringify(rawCwd)}.`,
        };
      }
      const nonWorkspace = detectNonWorkspaceCwd(env, getProcessCwd());
      if (nonWorkspace) {
        return {
          ok: false,
          error: `Error: 'cwd' must be an absolute workspace path because this host did not report a workspace root via MCP roots/list and the MCP server started in ${nonWorkspace.place} (${nonWorkspace.dir}), which is not a workspace. Received relative cwd: ${JSON.stringify(rawCwd)}.`,
        };
      }
    }
    return { ok: true, value: { ...args, cwd: rawCwd } as unknown as T };
  };

  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION,
    onInitialize: ({ clientInfo }) => {
      hostCompat = resolveHostCompat({
        clientInfo,
        env,
        configEditsFormat: savedEditsFormat,
      });
    },
    shouldRequestRoots: (_toolName, args) => {
      const rawCwd = args.cwd;
      if (rawCwd !== undefined && rawCwd !== null && typeof rawCwd !== "string") {
        return false;
      }
      if (typeof rawCwd !== "string" || !rawCwd.trim()) return true;
      const trimmed = rawCwd.trim();
      const isHome =
        trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
      return !path.isAbsolute(trimmed) && !isHome;
    },
    onWorkspaceRoots: (paths) => {
      for (const candidate of paths) {
        try {
          if (fs.statSync(candidate).isDirectory()) {
            defaultCwd = candidate;
            return;
          }
        } catch {
          // Ignore nonexistent or inaccessible root paths
        }
      }
    },
  });

  server.registerTool(
    {
      name: "batch_search",
      description:
        "Parallel search: literal text, regex, fuzzy paths, glob (*/{a,b}, no |), read-only git. Absolute cwd if no roots/list (Desktop 2.0 Hub). path rel/abs file/dir; glob filters text/regex; fileType lang/ext (text/regex/fuzzy). multiline spans lines (dot too); count/file=lines or multiline occurrences. Defaults: outputMode=content, caseSensitive=true, contextLines=0, maxResults=40, maxChars=8500 (8800B UTF-8 max); glob sortBy=path (mtime newest).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "fuzzy", "git"],
                },
                pattern: { type: "string" },
                path: { type: "string" },
                glob: { type: "string" },
                multiline: { type: "boolean" },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"],
                },
                fileType: { type: "string" },
                sortBy: { type: "string", enum: ["path", "mtime"] },
                caseSensitive: { type: "boolean" },
                contextLines: { type: "integer", minimum: 0, maximum: 5 },
                maxResults: { type: "integer", minimum: 1, maximum: 200 },
              },
              required: ["type", "pattern"],
            },
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 },
        },
        required: ["queries"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<BatchSearchInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runBatchSearch(resolved.value);
    },
  );

  server.registerTool(
    () => buildApplyEditsToolDefinition(hostCompat),
    async (args) => {
      const resolved = resolveToolArgs<ApplyEditsInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runApplyEdits(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "read_slices",
      description:
        "Batch outlines (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) + tiny <=120-line slices. For >150 known lines total, prefer parallel read_file(StartLine, EndLine) if available (agy: 46KB/call, no remote check). Absolute cwd if no roots/list (Desktop 2.0 Hub). slices: 1-based inclusive [start,end]; lineRanges: 'path:start-end,s2-e2'. maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
          },
          slices: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 },
                  },
                },
              },
              required: ["path", "ranges"],
            },
          },
          lineRanges: {
            type: "array",
            maxItems: 30,
            items: { type: "string" },
          },
          maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
        },
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<ReadSlicesInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runReadSlices(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "quick_outline",
      description:
        "Fast symbol/section line-range outlines for large files (TS/JS/HTML/Vue/Svelte/CSS/Py/GDScript/Go/Rust/Java/MD/JSON/YAML; prefer 10-20, max 40) before parallel ranged read_file(StartLine, EndLine). Flat paths-only schema. Absolute cwd if no roots/list (Desktop 2.0 Hub). maxChars default 8500; 8800 UTF-8 bytes total.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 40,
            items: { type: "string" },
          },
          maxChars: { type: "integer", minimum: 1000, maximum: 8800 },
        },
        required: ["paths"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<QuickOutlineInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runQuickOutline(resolved.value);
    },
  );

  server.registerTool(
    {
      name: "run_checks",
      description:
        `Batch >=2 independent non-interactive shell commands concurrently (for 1 lightweight command, prefer run_command). outputMode 'compact' (default) hides pass logs, keeps failures; 'full' keeps passing stdout. concurrency default 4. Per-cmd timeoutSec default 60; shared ${MCP_CALL_BUDGET_SEC}s budget (agy drops results at 180s; commands that cannot start are marked not run). Absolute cwd if no roots/list (Desktop 2.0 Hub); command.cwd overrides; name is label. maxChars default 8000; 8800 UTF-8 bytes total.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
              },
              required: ["command"],
            },
          },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          timeoutSec: { type: "integer", minimum: 1, maximum: MCP_CALL_BUDGET_SEC },
          outputMode: { type: "string", enum: ["compact", "full"] },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 },
        },
        required: ["commands"],
      },
    },
    async (args) => {
      const resolved = resolveToolArgs<RunChecksInput>(args);
      if (!resolved.ok) return { text: resolved.error, isError: true };
      return runChecks(resolved.value);
    },
  );

  return server;
}

function main(): void {
  if (process.argv[2] === "--cli") {
    void runAgyFastCli(process.argv.slice(3))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      });
    return;
  }

  const server = createAgyFastServer();
  let flushing = false;
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    if (flushing) return;
    flushing = true;
    // Failsafe timer prevents broken Windows named pipes from stalling stdout.end()
    // and provoking forced CTRL_C/CTRL_BREAK termination (0xc000013a).
    const failsafe = setTimeout(() => {
      process.exit(0);
    }, 150);
    failsafe.unref();
    try {
      // Wait for buffered stdout pipe writes (>64KB) to drain before exiting
      process.stdout.end(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
  };
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (
      flushing ||
      err.code === "EPIPE" ||
      err.code === "EOF" ||
      err.code === "ECONNRESET" ||
      err.code === "ERR_STREAM_DESTROYED" ||
      err.code === "ERR_STREAM_WRITE_AFTER_END"
    ) {
      exitImmediately();
    }
  });
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  if (process.platform === "win32") {
    process.on("SIGBREAK", exitImmediately);
  }
  server.listen(process.stdin, process.stdout, flushAndExit);
}

main();
