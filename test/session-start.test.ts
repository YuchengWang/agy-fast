import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildWorkspaceSnapshot,
  isHomeOrSystemRoot,
  parsePorcelainBranchHeader,
} from "../src/utils/snapshot.js";

const HOOK_SCRIPT = path.resolve(process.cwd(), "dist", "session-start.mjs");

function runHook(
  stdinText: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AGY_FAST_AUTO_UPDATE: "off" };
    delete env.ANTIGRAVITY_LS_VERSION;
    delete env.ANTIGRAVITY_APP_DATA_DIR;
    delete env.AGY_FAST_HOST;
    delete env.AGY_FAST_EDITS_FORMAT;
    delete env.AGY_FAST_CACHE_DIR;
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, durationMs: Date.now() - start }),
    );
    child.stdin.end(stdinText);
  });
}

describe("session-start hook", () => {
  let gitDir: string;
  let plainDir: string;

  before(async () => {
    gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-git-"));
    plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-plain-"));

    await fs.mkdir(path.join(gitDir, "src"), { recursive: true });
    await fs.mkdir(path.join(gitDir, "node_modules", "noisy"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(gitDir, "package.json"),
      JSON.stringify({
        name: "demo-app",
        scripts: { build: "tsc", test: "node --test", lint: "eslint ." },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(gitDir, "Makefile"),
      "build:\n\techo build\ntest:\n\techo test\n",
      "utf8",
    );
    await fs.writeFile(path.join(gitDir, "src", "index.ts"), "export {};\n", "utf8");
    await fs.writeFile(
      path.join(gitDir, "node_modules", "noisy", "junk.js"),
      "module.exports = {};\n",
      "utf8",
    );

    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: gitDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitDir });
    execFileSync("git", ["add", "package.json", "Makefile", "src/index.ts"], {
      cwd: gitDir,
    });
    execFileSync("git", ["commit", "-q", "-m", "feat: initial setup"], {
      cwd: gitDir,
    });
    // Create dirty file
    await fs.writeFile(path.join(gitDir, "src", "dirty.ts"), "export const x = 1;\n", "utf8");

    // Non-git workspace
    await fs.writeFile(path.join(plainDir, "go.mod"), "module example.com/demo\n", "utf8");
  });

  after(async () => {
    await fs.rm(gitDir, { recursive: true, force: true });
    await fs.rm(plainDir, { recursive: true, force: true });
  });

  it("injects a compact git + project + 2-level tree snapshot within 1500 chars", async () => {
    const res = await runHook(
      JSON.stringify({
        cwd: gitDir,
        workspacePaths: [gitDir],
        hookEventName: "SessionStart",
      }),
    );

    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    const parsed = JSON.parse(res.stdout);
    const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.equal(typeof msg, "string");
    assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
    assert.match(msg, /Git: branch/);
    assert.match(msg, /feat: initial setup/);
    assert.match(msg, /dirty\.ts/);
    assert.match(msg, /package\.json \(demo-app\) scripts: build, test, lint/);
    assert.match(msg, /Makefile targets: build, test/);
    assert.doesNotMatch(msg, /node_modules/);
  });

  it("works cleanly in non-git directories", async () => {
    const res = await runHook(JSON.stringify({ workspacePaths: [plainDir] }));
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(msg, /go\.mod \(example\.com\/demo\)/);
    assert.doesNotMatch(msg, /Git: branch/);
  });

  it("fails open with {} on empty, malformed, or missing workspace stdin", async () => {
    for (const input of [
      "",
      "{not-valid-json",
      JSON.stringify({ cwd: path.join(gitDir, "nonexistent-dir") }),
    ]) {
      const res = await runHook(input);
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    }
  });

  it("handles unborn git repos (0 commits) and snake_case workspace_roots payloads", async () => {
    const unbornDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-unborn-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unbornDir });
      await fs.writeFile(path.join(unbornDir, "hello.ts"), "export const a = 1;\n", "utf8");

      const res = await runHook(JSON.stringify({ workspace_roots: [unbornDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg, /Git: branch `main` \(unborn, no commits yet\)/);
      assert.match(msg, /hello\.ts/);
    } finally {
      await fs.rm(unbornDir, { recursive: true, force: true });
    }
  });

  it("preserves Project and Layout sections even when a repo has 50+ long-path modified files", async () => {
    const dirtyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-dirty-"));
    try {
      await fs.mkdir(path.join(dirtyDir, "packages", "service-alpha", "src", "adapters", "very-deep-module"), {
        recursive: true,
      });
      await fs.mkdir(path.join(dirtyDir, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(dirtyDir, "package.json"),
        JSON.stringify({
          name: "monorepo-heavy",
          scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(dirtyDir, "docs", "README.md"), "# docs\n", "utf8");

      // Create and commit 55 files with long paths, then modify all 55 (reproducing 139-file dirty workspace truncation)
      const longFiles = Array.from({ length: 55 }, (_, i) =>
        path.join(
          dirtyDir,
          "packages",
          "service-alpha",
          "src",
          "adapters",
          "very-deep-module",
          `LongServiceAdapterImplementationFile_${String(i).padStart(2, "0")}.ts`,
        ),
      );
      await Promise.all(
        longFiles.map((f, i) => fs.writeFile(f, `export const idx = ${i};\n`, "utf8")),
      );

      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dirtyDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dirtyDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dirtyDir });
      execFileSync("git", ["add", "."], { cwd: dirtyDir });
      execFileSync("git", ["commit", "-q", "-m", "feat: baseline commit with a fairly descriptive message for testing"], {
        cwd: dirtyDir,
      });

      await Promise.all(
        longFiles.map((f, i) => fs.writeFile(f, `export const idx = ${i + 100};\n`, "utf8")),
      );

      const res = await runHook(JSON.stringify({ cwd: dirtyDir, workspacePaths: [dirtyDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.equal(typeof msg, "string");
      assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
      assert.match(msg, /Git: branch `main`/);
      assert.match(msg, /Modified \(55\):/);
      assert.match(msg, /\(\+\d+ more\)/);
      assert.match(msg, /Project:\n  - package\.json \(monorepo-heavy\) scripts: build, test, lint/);
      assert.match(msg, /Layout \(2 levels\):/);
      assert.match(msg, /packages\//);
    } finally {
      await fs.rm(dirtyDir, { recursive: true, force: true });
    }
  });

  it("detects multi-module subproject manifests (pom.xml + web/package.json) and collapses noisy tmp/output dirs", async () => {
    const monoDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-mono-"));
    try {
      await fs.mkdir(path.join(monoDir, ".claude", "memory"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "server", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "web", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "output"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "tmp"), { recursive: true });

      await fs.writeFile(
        path.join(monoDir, "server", "pom.xml"),
        "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>autocard-server</artifactId></project>\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(monoDir, "web", "package.json"),
        JSON.stringify({ name: "autocard-web", scripts: { dev: "vite", build: "vite build", test: "node --test" } }),
        "utf8",
      );
      for (let i = 0; i < 15; i++) {
        await fs.writeFile(
          path.join(monoDir, "output", `很长的中文交付报告文件名_${i}_20261119.docx`),
          "x",
          "utf8",
        );
        await fs.writeFile(path.join(monoDir, "tmp", `scratch_temp_file_${i}.txt`), "x", "utf8");
      }

      const res = await runHook(JSON.stringify({ cwd: monoDir, workspacePaths: [monoDir] }));
      assert.equal(res.code, 0);
      const parsed = JSON.parse(res.stdout);
      const msg: string = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.ok(msg.length <= 1500, `Snapshot exceeded 1500 chars: ${msg.length}`);
      assert.match(msg, /server\/pom\.xml \(autocard-server, maven\)/);
      assert.match(msg, /web\/package\.json \(autocard-web\) scripts: dev, build, test/);
      assert.match(msg, /web\//);
      assert.match(msg, /output\/ \(15 entries\)/);
      assert.match(msg, /tmp\/ \(15 entries\)/);
      assert.doesNotMatch(msg, /\.claude\//);

      // Verify 2nd-level subdir prioritization & build/report filtering (e.g. SourcingAgent/ in monorepo)
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "data"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "dist-server"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "docs"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "memory"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "playwright-report"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "public"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "src"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "tests"), { recursive: true });
      await fs.mkdir(path.join(monoDir, "SourcingAgent", "zebra"), { recursive: true });

      const res2 = await runHook(JSON.stringify({ cwd: monoDir, workspacePaths: [monoDir] }));
      assert.equal(res2.code, 0);
      const msg2: string = JSON.parse(res2.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg2, /SourcingAgent\/ \(src\/, tests\//);
      assert.doesNotMatch(msg2, /dist-server/);
      assert.doesNotMatch(msg2, /playwright-report/);
    } finally {
      await fs.rm(monoDir, { recursive: true, force: true });
    }
  });

  it("exits promptly when stdin stays open without EOF and enforces <=1500 UTF-8 bytes with zero lone surrogates", async () => {
    const cjkDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-cjk-"));
    try {
      // Create CJK + 4-byte emoji filenames positioned across shortEntryName(28) and byte cap boundaries
      await fs.writeFile(path.join(cjkDir, `${"a".repeat(24)}🚀b.ts`), "export const a = 1;\n", "utf8");
      for (let i = 0; i < 20; i++) {
        await fs.writeFile(
          path.join(cjkDir, `中文模块文件名称很长_${String(i).padStart(2, "0")}_🚀数据.ts`),
          "export {};\n",
          "utf8",
        );
      }
      const res = await runHook(JSON.stringify({ cwd: cjkDir, workspacePaths: [cjkDir] }));
      assert.equal(res.code, 0);
      const msg: string = JSON.parse(res.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.equal(typeof msg, "string");
      assert.ok(
        Buffer.byteLength(msg, "utf8") <= 1500,
        `Expected snapshot <= 1500 UTF-8 bytes, got ${Buffer.byteLength(msg, "utf8")}`,
      );
      assert.equal(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(msg),
        false,
        "Snapshot must not contain unpaired UTF-16 surrogates",
      );

      // Verify hook exits cleanly after readStdin timeout even if parent never closes stdin
      const noEofResult = await new Promise<{ code: number | null; stdout: string; durationMs: number }>(
        (resolve, reject) => {
          const start = Date.now();
          const child = spawn(process.execPath, [HOOK_SCRIPT], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_FAST_AUTO_UPDATE: "off" },
          });
          let stdout = "";
          const killer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("SessionStart hook hung when stdin stayed open without EOF"));
          }, 3500);
          killer.unref();
          child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
          child.on("error", (err) => {
            clearTimeout(killer);
            reject(err);
          });
          child.on("close", (code) => {
            clearTimeout(killer);
            resolve({ code, stdout, durationMs: Date.now() - start });
          });
          // Write payload WITHOUT calling child.stdin.end()
          child.stdin.write(JSON.stringify({ cwd: cjkDir }));
        },
      );
      assert.equal(noEofResult.code, 0);
      assert.ok(
        noEofResult.durationMs < 1000,
        `Expected complete JSON stdin without EOF to exit immediately (<1000ms), got ${noEofResult.durationMs}ms`,
      );
      const parsed = JSON.parse(noEofResult.stdout);
      assert.match(parsed?.injectSteps?.[0]?.systemMessage?.systemMessage ?? "", /agy-fast startup snapshot/);

      // Verify SessionStart git snapshot does NOT execute untrusted .git/config core.fsmonitor
      const untrustedGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-hook-fsmon-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: untrustedGitDir });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: untrustedGitDir });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: untrustedGitDir });
        await fs.writeFile(path.join(untrustedGitDir, "a.txt"), "1\n", "utf8");
        execFileSync("git", ["add", "."], { cwd: untrustedGitDir });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: untrustedGitDir });
        const markerFs = path.join(untrustedGitDir, "pwn_hook_fs");
        const touchCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(markerFs)},'1')`)}`;
        execFileSync("git", ["config", "core.fsmonitor", touchCmd], { cwd: untrustedGitDir });
        const snapRes = await runHook(JSON.stringify({ cwd: untrustedGitDir }));
        assert.equal(snapRes.code, 0);
        assert.equal(await fs.access(markerFs).then(() => true, () => false), false);
      } finally {
        await fs.rm(untrustedGitDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(cjkDir, { recursive: true, force: true });
    }
  });

  it("injects [agy-fast compat] notice only on pre-eager CLI 1.5.0-1.5.7 and adds 0 bytes on CLI >=1.5.8 / Desktop / IDE", async () => {
    const cliOldRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-cli/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" },
    );
    assert.equal(cliOldRes.code, 0);
    const cliOldMsg: string = JSON.parse(cliOldRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.ok(Buffer.byteLength(cliOldMsg, "utf8") <= 1500);
    assert.match(cliOldMsg, /\[agy-fast compat\] host=cli@1\.5\.7/);
    assert.match(cliOldMsg, /JSON array string/);

    // Eager-capable CLI >=1.5.8 omits the compat notice (0 extra tokens/bytes; avoids conflicting with typed eager tools)
    const cliEagerRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-cli/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.13" },
    );
    const cliEagerMsg: string = JSON.parse(cliEagerRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(cliEagerMsg, /\[agy-fast compat\]/);

    // Desktop 2.0 & IDE omit the compat line (0 extra tokens/bytes)
    const desktopRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "desktop-2.34.0" },
    );
    const desktopMsg: string = JSON.parse(desktopRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(desktopMsg, /\[agy-fast compat\]/);

    // IDE path with conflicting ambient pre-eager CLI env still resolves IDE (no compat notice)
    const ideRes = await runHook(
      JSON.stringify({
        cwd: plainDir,
        transcriptPath: "/Users/dev/.gemini/antigravity-ide/brain/1/transcript.jsonl",
      }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7" },
    );
    const ideMsg: string = JSON.parse(ideRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(ideMsg, /\[agy-fast compat\]/);

    // Explicit AGY_FAST_EDITS_FORMAT=array suppresses notice even on CLI 1.5.7; =string forces it on CLI 1.5.13
    const overrideArrRes = await runHook(
      JSON.stringify({ cwd: plainDir }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.7", AGY_FAST_EDITS_FORMAT: "array" },
    );
    const overrideArrMsg: string = JSON.parse(overrideArrRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.doesNotMatch(overrideArrMsg, /\[agy-fast compat\]/);

    const overrideStrRes = await runHook(
      JSON.stringify({ cwd: plainDir }),
      { ANTIGRAVITY_LS_VERSION: "cli-1.5.13", AGY_FAST_EDITS_FORMAT: "string" },
    );
    const overrideStrMsg: string = JSON.parse(overrideStrRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
    assert.match(overrideStrMsg, /\[agy-fast compat\] host=cli@1\.5\.13/);
  });

  it("skips OS/cloud blacklist dirs always, protects home-root dirs only on $HOME, and trips scan timeout cleanly", async () => {
    // 1. Normal project repo: OS blacklist (AppData, OneDrive) skipped, but legitimate public/ & documents/ preserved
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-proj-bl-"));
    const fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fake-home-"));
    try {
      for (const d of ["src", "public", "documents", "recovery", "AppData", "OneDrive", "OneDrive - Acme", "$RECYCLE.BIN"]) {
        await fs.mkdir(path.join(projDir, d), { recursive: true });
      }
      await fs.writeFile(path.join(projDir, "public", "index.html"), "<html/>", "utf8");
      await fs.writeFile(path.join(projDir, "src", "app.ts"), "export const x = 1;\n", "utf8");
      const projSnap = await buildWorkspaceSnapshot(projDir);
      assert.ok(projSnap);
      const projBody = projSnap.split("\n").slice(1).join("\n");
      assert.match(projBody, /public\//);
      assert.match(projBody, /documents\//);
      assert.match(projBody, /recovery\//);
      assert.match(projBody, /src\//);
      assert.doesNotMatch(projBody, /AppData/);
      assert.doesNotMatch(projBody, /OneDrive/);
      assert.doesNotMatch(projBody, /\$RECYCLE\.BIN/);

      // 2. When workspaceDir IS $HOME: Desktop/Documents/Downloads/Library/Public/Recovery/AppData/NTUSER.DAT* are skipped
      for (const d of ["Desktop", "Documents", "Downloads", "Library", "Pictures", "Public", "Recovery", "AppData", "OneDrive", "my-app"]) {
        await fs.mkdir(path.join(fakeHomeDir, d), { recursive: true });
      }
      await fs.writeFile(path.join(fakeHomeDir, "NTUSER.DAT"), "reg", "utf8");
      await fs.writeFile(path.join(fakeHomeDir, "NTUSER.DAT{016888bd-6c6f-11de-8d1d-001e0bcde3ec}.TM.blf"), "reg", "utf8");
      await fs.writeFile(path.join(fakeHomeDir, "my-app", "package.json"), '{"name":"my-app"}', "utf8");
      // Also test symlinked Application Data junction-like entry
      await fs.symlink(
        path.join(fakeHomeDir, "AppData"),
        path.join(fakeHomeDir, "Application Data"),
        process.platform === "win32" ? "junction" : "dir",
      ).catch(() => {});

      const homeHookRes = await runHook(JSON.stringify({ cwd: fakeHomeDir }), {
        HOME: fakeHomeDir,
        USERPROFILE: fakeHomeDir,
      });
      assert.equal(homeHookRes.code, 0);
      const homeMsg: string = JSON.parse(homeHookRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.ok(homeMsg);
      const homeBody = homeMsg.split("\n").slice(1).join("\n");
      assert.match(homeBody, /Layout \(1 level\):/);
      assert.match(homeBody, /my-app\//);
      assert.doesNotMatch(homeBody, /my-app\/package\.json/);
      assert.doesNotMatch(homeBody, /Desktop\//);
      assert.doesNotMatch(homeBody, /Documents\//);
      assert.doesNotMatch(homeBody, /Downloads\//);
      assert.doesNotMatch(homeBody, /Library\//);
      assert.doesNotMatch(homeBody, /Pictures\//);
      assert.doesNotMatch(homeBody, /Public\//);
      assert.doesNotMatch(homeBody, /Recovery\//);
      assert.doesNotMatch(homeBody, /AppData/);
      assert.doesNotMatch(homeBody, /Application Data/);
      assert.doesNotMatch(homeBody, /OneDrive/);
      assert.doesNotMatch(homeBody, /NTUSER\.DAT/);

      // Direct unit check: $HOME snapshot must NOT readdir depth-2 child dirs or probe child manifests
      const prevHome = process.env.HOME;
      const prevUserProfile = process.env.USERPROFILE;
      const origReaddirHome = fs.readdir as (...args: unknown[]) => Promise<unknown>;
      const readdirTargets: string[] = [];
      process.env.HOME = fakeHomeDir;
      process.env.USERPROFILE = fakeHomeDir;
      (fs as unknown as { readdir: (...args: unknown[]) => Promise<unknown> }).readdir = (
        p: unknown,
        ...rest: unknown[]
      ) => {
        readdirTargets.push(String(p));
        return origReaddirHome(p, ...rest);
      };
      try {
        const directHomeSnap = await buildWorkspaceSnapshot(fakeHomeDir);
        assert.ok(directHomeSnap);
        assert.match(directHomeSnap, /Layout \(1 level\):/);
        assert.doesNotMatch(directHomeSnap, /scan timed out/);
        assert.deepEqual(readdirTargets, [fakeHomeDir]);
      } finally {
        (fs as unknown as { readdir: (...args: unknown[]) => Promise<unknown> }).readdir = origReaddirHome;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
      }

      // Verify isHomeOrSystemRoot directly on filesystem root
      assert.equal(await isHomeOrSystemRoot(path.parse(projDir).root), true);
      assert.equal(await isHomeOrSystemRoot(projDir), false);

      // 3. Scan timeout circuit-breaker bounds latency cleanly on slow directories
      const origReaddir = fs.readdir as (...args: unknown[]) => Promise<unknown>;
      const slowChildPath = path.join(projDir, "src");
      const pendingMockTimers: NodeJS.Timeout[] = [];
      (fs as unknown as { readdir: (...args: unknown[]) => Promise<unknown> }).readdir = (
        p: unknown,
        ...rest: unknown[]
      ) => {
        if (String(p) === slowChildPath) {
          return new Promise<unknown>((resolve, reject) => {
            const t = setTimeout(() => {
              origReaddir(p, ...rest).then(resolve, reject);
            }, 300);
            t.unref();
            pendingMockTimers.push(t);
          });
        }
        return origReaddir(p, ...rest);
      };
      try {
        const start = Date.now();
        const timedSnap = await buildWorkspaceSnapshot(projDir, { scanTimeoutMs: 30 });
        const elapsed = Date.now() - start;
        assert.ok(timedSnap);
        assert.ok(elapsed < 220, `Expected timeout circuit-breaker <220ms, got ${elapsed}ms`);
        assert.match(timedSnap, /scan timed out/);
      } finally {
        for (const t of pendingMockTimers) clearTimeout(t);
        (fs as unknown as { readdir: (...args: unknown[]) => Promise<unknown> }).readdir = origReaddir;
      }
    } finally {
      await fs.rm(projDir, { recursive: true, force: true });
      await fs.rm(fakeHomeDir, { recursive: true, force: true });
    }
  });

  it("hooks.json command resolves dist/session-start.mjs from an unrelated workspace CWD", async () => {
    const hooksConfig = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "hooks.json"), "utf8"),
    ) as {
      "agy-fast-snapshot": { SessionStart: Array<{ command: string }> };
    };
    const hookCmd = hooksConfig["agy-fast-snapshot"].SessionStart[0]!.command;
    // Must stay free of shell metacharacters that differ across sh -c and Windows cmd /c
    assert.doesNotMatch(hookCmd, /[$%!<>|&`\\]/);

    const runShellHook = (
      cwd: string,
      stdinText: string,
      extraEnv: Record<string, string | undefined>,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, AGY_FAST_AUTO_UPDATE: "off" };
        delete env.PLUGIN_ROOT;
        delete env.AGY_PLUGIN_ROOT;
        delete env.GEMINI_HOME;
        for (const [k, v] of Object.entries(extraEnv)) {
          if (v === undefined) delete env[k];
          else env[k] = v;
        }
        const child = spawn(hookCmd, {
          cwd,
          env,
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdinText);
      });

    const unrelatedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-unrelated-ws-"));
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-fake-home-"));
    try {
      await fs.writeFile(
        path.join(unrelatedWorkspace, "package.json"),
        JSON.stringify({ name: "unrelated-biz-app", scripts: { test: "node --test" } }),
        "utf8",
      );

      // 1. With PLUGIN_ROOT set and CWD = unrelated business workspace
      const withRoot = await runShellHook(
        unrelatedWorkspace,
        JSON.stringify({ cwd: unrelatedWorkspace, workspacePaths: [unrelatedWorkspace] }),
        { PLUGIN_ROOT: process.cwd(), HOME: fakeHome, USERPROFILE: fakeHome },
      );
      assert.equal(withRoot.code, 0, `stderr: ${withRoot.stderr}`);
      assert.equal(withRoot.stderr, "");
      const msg1: string = JSON.parse(withRoot.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg1, /unrelated-biz-app/);

      // 2. Without PLUGIN_ROOT, falls back to ~/.gemini/config/plugins/agy-fast
      const globalPlugin = path.join(fakeHome, ".gemini", "config", "plugins", "agy-fast");
      await fs.mkdir(path.join(globalPlugin, "dist"), { recursive: true });
      await fs.copyFile(path.resolve(process.cwd(), "plugin.json"), path.join(globalPlugin, "plugin.json"));
      await fs.copyFile(HOOK_SCRIPT, path.join(globalPlugin, "dist", "session-start.mjs"));

      const viaHomeFallback = await runShellHook(
        unrelatedWorkspace,
        JSON.stringify({ cwd: unrelatedWorkspace, workspacePaths: [unrelatedWorkspace] }),
        { HOME: fakeHome, USERPROFILE: fakeHome },
      );
      assert.equal(viaHomeFallback.code, 0, `stderr: ${viaHomeFallback.stderr}`);
      assert.equal(viaHomeFallback.stderr, "");
      const msg2: string = JSON.parse(viaHomeFallback.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.match(msg2, /unrelated-biz-app/);

      // 3. Untrusted workspace with decoy plugin.json + dist/session-start.mjs (root or .agents) must NOT override global install
      const untrustedWs = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-untrusted-ws-"));
      try {
        await fs.writeFile(
          path.join(untrustedWs, "package.json"),
          JSON.stringify({ name: "untrusted-repo-app" }),
          "utf8",
        );
        const marker = path.join(untrustedWs, "pwned-hook");
        const poison = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "1");`;
        for (const decoyDir of [untrustedWs, path.join(untrustedWs, ".agents", "plugins", "agy-fast")]) {
          await fs.mkdir(path.join(decoyDir, "dist"), { recursive: true });
          await fs.writeFile(path.join(decoyDir, "plugin.json"), '{"name":"agy-fast"}', "utf8");
          await fs.writeFile(path.join(decoyDir, "dist", "session-start.mjs"), poison, "utf8");
        }
        const safeRes = await runShellHook(
          untrustedWs,
          JSON.stringify({ cwd: untrustedWs, workspacePaths: [untrustedWs] }),
          { HOME: fakeHome, USERPROFILE: fakeHome },
        );
        assert.equal(safeRes.code, 0, `stderr: ${safeRes.stderr}`);
        assert.equal(safeRes.stderr, "");
        const safeMsg: string = JSON.parse(safeRes.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
        assert.match(safeMsg, /untrusted-repo-app/);
        assert.equal(await fs.access(marker).then(() => true, () => false), false);
      } finally {
        await fs.rm(untrustedWs, { recursive: true, force: true });
      }

      // 4. Isolated GEMINI_HOME resolves <GEMINI_HOME>/config/plugins/agy-fast even when HOME has no plugin
      const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-empty-home-"));
      const isoGeminiHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-iso-gemini-"));
      try {
        const isoPlugin = path.join(isoGeminiHome, "config", "plugins", "agy-fast");
        await fs.mkdir(path.join(isoPlugin, "dist"), { recursive: true });
        await fs.copyFile(path.resolve(process.cwd(), "plugin.json"), path.join(isoPlugin, "plugin.json"));
        await fs.copyFile(HOOK_SCRIPT, path.join(isoPlugin, "dist", "session-start.mjs"));

        const viaGeminiHome = await runShellHook(
          unrelatedWorkspace,
          JSON.stringify({ cwd: unrelatedWorkspace, workspacePaths: [unrelatedWorkspace] }),
          { HOME: emptyHome, USERPROFILE: emptyHome, GEMINI_HOME: isoGeminiHome },
        );
        assert.equal(viaGeminiHome.code, 0, `stderr: ${viaGeminiHome.stderr}`);
        assert.equal(viaGeminiHome.stderr, "");
        const msgIso: string = JSON.parse(viaGeminiHome.stdout)?.injectSteps?.[0]?.systemMessage?.systemMessage;
        assert.match(msgIso, /unrelated-biz-app/);

        // 5. When no plugin dir exists anywhere, fails open with {} and exit code 0
        const failOpen = await runShellHook(
          unrelatedWorkspace,
          JSON.stringify({ cwd: unrelatedWorkspace }),
          { HOME: emptyHome, USERPROFILE: emptyHome },
        );
        assert.equal(failOpen.code, 0);
        assert.equal(failOpen.stderr, "");
        assert.deepEqual(JSON.parse(failOpen.stdout), {});
      } finally {
        await fs.rm(emptyHome, { recursive: true, force: true });
        await fs.rm(isoGeminiHome, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(unrelatedWorkspace, { recursive: true, force: true });
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("prioritizes root manifests over subprojects and handles detached HEAD cleanly", async () => {
    const monoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-root-prio-"));
    try {
      await fs.writeFile(
        path.join(monoRoot, "package.json"),
        JSON.stringify({ name: "root-workspace", scripts: { test: "vitest" } }),
        "utf8",
      );
      for (const sub of ["a-api", "b-app", "c-auth", "d-cli", "e-core", "f-edge", "g-web"]) {
        await fs.mkdir(path.join(monoRoot, sub), { recursive: true });
        await fs.writeFile(
          path.join(monoRoot, sub, "package.json"),
          JSON.stringify({ name: sub }),
          "utf8",
        );
      }
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: monoRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: monoRoot });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: monoRoot });
      execFileSync("git", ["add", "package.json"], { cwd: monoRoot });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: monoRoot });
      execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: monoRoot });

      const snap = await buildWorkspaceSnapshot(monoRoot);
      assert.ok(snap);
      assert.match(snap, /Project:\n  - package\.json \(root-workspace\) scripts: test/);
      assert.match(snap, /Git: branch `HEAD`/);
    } finally {
      await fs.rm(monoRoot, { recursive: true, force: true });
    }
  });

  it("strips upstream suffix on unborn porcelain headers and falls back on git status timeout even when git log fails", async () => {
    // 1. Direct porcelain branch header parsing (unborn with upstream tracking, detached, normal)
    assert.deepEqual(
      parsePorcelainBranchHeader("## No commits yet on main...origin/main"),
      { branch: "main", isUnborn: true },
    );
    assert.deepEqual(
      parsePorcelainBranchHeader("## Initial commit on feat/x...origin/feat/x"),
      { branch: "feat/x", isUnborn: true },
    );
    assert.deepEqual(
      parsePorcelainBranchHeader("## main...origin/main [ahead 1, behind 2]"),
      { branch: "main", isUnborn: false },
    );
    assert.deepEqual(
      parsePorcelainBranchHeader("## HEAD (no branch)"),
      { branch: "HEAD", isUnborn: false },
    );

    const unbornTrackedDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-unborn-up-"));
    const brokenGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-broken-git-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unbornTrackedDir });
      execFileSync("git", ["config", "branch.main.remote", "origin"], { cwd: unbornTrackedDir });
      execFileSync("git", ["config", "branch.main.merge", "refs/heads/main"], { cwd: unbornTrackedDir });
      await fs.writeFile(path.join(unbornTrackedDir, "index.ts"), "export const v = 1;\n", "utf8");

      // 2. End-to-end unborn repo with upstream tracking must not leak `...origin/main`
      const unbornSnap = await buildWorkspaceSnapshot(unbornTrackedDir);
      assert.ok(unbornSnap);
      assert.match(unbornSnap, /Git: branch `main` \(unborn, no commits yet\)/);
      assert.doesNotMatch(unbornSnap, /\.\.\.origin\/main/);

      // 3. When git status times out AND git log fails (exit 128 on unborn repo), still render Git unknown status
      const snapTimeoutLogFail = await buildWorkspaceSnapshot(unbornTrackedDir, {
        gitExec: async (_bin, args) => {
          if (args.includes("status")) {
            return {
              exitCode: null,
              signal: "SIGTERM",
              timedOut: true,
              durationMs: 800,
              stdout: "",
              stderr: "",
              truncated: false,
            };
          }
          return {
            exitCode: 128,
            signal: null,
            timedOut: false,
            durationMs: 10,
            stdout: "",
            stderr: "fatal: your current branch 'main' does not have any commits yet",
            truncated: false,
          };
        },
      });
      assert.ok(snapTimeoutLogFail);
      assert.match(snapTimeoutLogFail, /Git: branch `main`/);
      assert.match(snapTimeoutLogFail, /Working tree: unknown \(git status timed out\)/);

      // 4. When BOTH git status and git log time out, still render Git unknown status via .git/HEAD
      const snapBothTimeout = await buildWorkspaceSnapshot(unbornTrackedDir, {
        gitExec: async () => ({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          durationMs: 800,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      });
      assert.ok(snapBothTimeout);
      assert.match(snapBothTimeout, /Git: branch `main`/);
      assert.match(snapBothTimeout, /Working tree: unknown \(git status timed out\)/);

      // 5. Invalid/broken .git directory without HEAD must NOT fabricate a Git section on timeout
      await fs.mkdir(path.join(brokenGitDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(brokenGitDir, "README.md"), "# broken\n", "utf8");
      const brokenSnap = await buildWorkspaceSnapshot(brokenGitDir, {
        gitExec: async () => ({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          durationMs: 800,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      });
      assert.ok(brokenSnap);
      assert.doesNotMatch(brokenSnap, /Git: branch/);
    } finally {
      await fs.rm(unbornTrackedDir, { recursive: true, force: true });
      await fs.rm(brokenGitDir, { recursive: true, force: true });
    }
  });

  it("renders CJK filenames verbatim without octal escaping in git status snapshot", async () => {
    const cjkDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-cjk-snap-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: cjkDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: cjkDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: cjkDir });
      execFileSync("git", ["config", "core.quotePath", "true"], { cwd: cjkDir });
      await fs.writeFile(path.join(cjkDir, "init.ts"), "export const a = 1;\n", "utf8");
      execFileSync("git", ["add", "init.ts"], { cwd: cjkDir });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: cjkDir });
      await fs.writeFile(path.join(cjkDir, "中文模块.ts"), "export const zh = true;\n", "utf8");

      const snap = await buildWorkspaceSnapshot(cjkDir);
      assert.ok(snap !== null, "Expected non-null workspace snapshot");
      assert.match(snap, /Modified \(1\):[^\n]*中文模块\.ts/);
      assert.ok(!snap.includes("\\344\\270\\255"), `Unexpected octal-escaped path in snapshot:\n${snap}`);
    } finally {
      await fs.rm(cjkDir, { recursive: true, force: true });
    }
  });

  it("lightly detects .agent/plugins/*/mcp_config.json and fast-audit scripts within 1.5KB", async () => {
    const pyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-py-snap-"));
    try {
      await fs.mkdir(path.join(pyDir, ".agent", "plugins", "fast-mcp"), { recursive: true });
      await fs.mkdir(path.join(pyDir, ".agent", "plugins", "empty-plugin"), { recursive: true });
      await fs.mkdir(path.join(pyDir, "scripts", "devops"), { recursive: true });
      await fs.writeFile(
        path.join(pyDir, "pyproject.toml"),
        "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(pyDir, ".agent", "plugins", "fast-mcp", "mcp_config.json"),
        '{"mcpServers":{}}',
        "utf8",
      );
      await fs.writeFile(
        path.join(pyDir, "scripts", "devops", "audit_redline.py"),
        "print('ok')\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(pyDir, "scripts", "check_fast.sh"),
        "#!/bin/sh\necho ok\n",
        "utf8",
      );

      const snap = await buildWorkspaceSnapshot(pyDir);
      assert.ok(snap !== null, "Expected non-null workspace snapshot");
      assert.ok(Buffer.byteLength(snap, "utf8") <= 1500, `Snapshot exceeded 1500 bytes: ${Buffer.byteLength(snap, "utf8")}`);
      assert.match(snap, /pyproject\.toml \(pytest, ruff, mypy\)/);
      assert.match(snap, /\.agent\/plugins\/fast-mcp\/mcp_config\.json/);
      assert.doesNotMatch(snap, /empty-plugin/);
      assert.match(snap, /Audit scripts: scripts\/check_fast\.sh, scripts\/devops\/audit_redline\.py/);
    } finally {
      await fs.rm(pyDir, { recursive: true, force: true });
    }
  });
});
