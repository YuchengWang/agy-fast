import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWaterFillBudgets,
  fitSectionsToBudget,
  fitSectionsToByteBudget,
  formatCompactCommandOutput,
  formatCompactCommandOutputWithMeta,
  formatExitFailureLabel,
  normalizeTerminalOutput,
  prepareCompactCommandOutput,
} from "../src/utils/output-filter.js";

describe("output-filter", () => {
  it("computeWaterFillBudgets allocates exact water-filling shares across edge cases", () => {
    assert.deepEqual(computeWaterFillBudgets([], 100), []);
    assert.deepEqual(computeWaterFillBudgets([10, 20], 0), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], -5), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([10, 20], Number.NaN), [0, 0]);

    // Fits entirely: everyone gets exact requested size
    assert.deepEqual(computeWaterFillBudgets([15, 30, 45], 200), [15, 30, 45]);

    // Empty / tiny items donate 100% of unused share to large items
    assert.deepEqual(
      computeWaterFillBudgets([0, 0, 0, 0, 2000, 2000], 2000),
      [0, 0, 0, 0, 1000, 1000],
    );
    assert.deepEqual(
      computeWaterFillBudgets([10, 500, 10, 500], 420),
      [10, 200, 10, 200],
    );

    // Remainder distributes evenly (max - min <= 1) and never exceeds requested size
    const budgets = computeWaterFillBudgets([10, 20, 30, 100], 77);
    assert.equal(budgets[0], 10);
    assert.equal(budgets[1], 20);
    assert.equal(budgets.reduce((a, b) => a + b, 0), 77);
    assert.ok(budgets[2]! <= 30 && budgets[3]! <= 100);
    assert.ok(Math.abs(budgets[2]! - budgets[3]!) <= 1);

    // Sanitizes negative/NaN item sizes as 0
    assert.deepEqual(
      computeWaterFillBudgets([-5, Number.NaN, 100], 60),
      [0, 0, 60],
    );

    // fitSectionsToBudget & fitSectionsToByteBudget inherit water-filling cleanly
    const fitted = fitSectionsToBudget(["[]", "[]", "A".repeat(400), "B".repeat(400)], 500);
    assert.ok(fitted.length <= 500);
    assert.match(fitted, /A{180,}/);
    assert.match(fitted, /B{180,}/);

    const cjkFitted = fitSectionsToByteBudget(["ok", "中文测试数据".repeat(200)], 2000, 400);
    assert.ok(Buffer.byteLength(cjkFitted, "utf8") <= 400);
    assert.ok(cjkFitted.startsWith("ok\n\n"));

    // Dual-cap binding (mixed CJK + long ASCII + short trailing section) must NEVER erase trailing section
    const dualMixed = fitSectionsToByteBudget(
      ["中".repeat(2000), "A".repeat(5000), "## [PASS] tiny-3\nTINY_CMD3_SURVIVED"],
      5400,
      8800,
    );
    assert.ok(dualMixed.length <= 5400);
    assert.ok(Buffer.byteLength(dualMixed, "utf8") <= 8800);
    assert.match(dualMixed, /TINY_CMD3_SURVIVED/);
  });

  it("strips benign zero-error summaries while preserving zero-indexed entity and prefix failures", () => {
    const benignLines = [
      "0 errors",
      "0 failed",
      "errors: 0",
      "failed: 0",
      "0 failures",
      "0 warnings",
      "Found 0 errors.",
      "Tests run: 24, Failures: 0, Errors: 0, Skipped: 0",
      "0 error(s), 0 warning(s)",
    ];
    const log = [
      ...benignLines,
      ...Array.from({ length: 80 }, (_, i) => `neutral log line ${i} ${"x".repeat(40)}`),
      "REAL_ROOT_CAUSE: error TS2322: Type 'string' is not assignable to type 'number'.",
      ...Array.from({ length: 30 }, (_, i) => `aftermath detail ${i} ${"y".repeat(40)}`),
      "FINAL_TAIL_MARKER: Build exited with code 2",
    ].join("\n");

    const res = formatCompactCommandOutputWithMeta({
      stdout: log,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars: 900,
    });

    assert.equal(res.truncated, true);
    assert.ok(res.text.length <= 900, `Expected <= 900 chars, got ${res.text.length}`);
    assert.doesNotMatch(res.text, /^0 errors/m);
    assert.doesNotMatch(res.text, /^errors: 0$/m);
    assert.doesNotMatch(res.text, /^failed: 0$/m);
    assert.match(res.text, /REAL_ROOT_CAUSE: error TS2322/);
    assert.match(res.text, /FINAL_TAIL_MARKER/);

    // Real failures containing 0 MUST still be recognized as error lines (never stripped)
    const realFailureLines = [
      "Worker 0 failed: exit code 1",
      "worker-0 failed: timeout",
      "worker #0 failed: crashed",
      "Step 0 failed while migrating DB",
      "Task 0 error: connection refused",
      "FAIL: 0/5 checks passed",
      "FAILED: 0 tests matched pattern",
      "FAILED: 0 (empty output)",
      "FAILED: 0 passed",
      "errors: 0.5% threshold breached",
      "failed: 0.25 ratio exceeded",
      "Failed: 0-byte artifact produced",
      "Failed: 0 retries left",
      'failed(0, "timeout")',
      "Error: 0 bytes written to socket",
      "Build completed with 0 errors, 1 failed",
    ];
    for (const failLine of realFailureLines) {
      const sample = [
        ...Array.from({ length: 50 }, (_, i) => `step ${i} ${"z".repeat(40)}`),
        failLine,
        ...Array.from({ length: 50 }, (_, i) => `trailing ${i} ${"w".repeat(40)}`),
        "END_MARKER",
      ].join("\n");
      const out = formatCompactCommandOutput({
        stdout: sample,
        stderr: "",
        exitCode: 1,
        timedOut: false,
        maxChars: 650,
      });
      assert.ok(
        out.includes(failLine),
        `Expected real failure line to be preserved as first root cause: ${failLine}\nGot:\n${out}`,
      );
      assert.match(out, /END_MARKER/);
    }
  });

  it("proactively folds green Vite/monorepo/test/compiler build runs even when <= maxChars, without expanding short runs", () => {
    const viteAndMonorepoLines = [
      "> @app/shared@1.0.0 build /repo/packages/shared",
      "> vite build",
      "",
      "vite v5.4.1 building for production...",
      "transforming...",
      "✓ 42 modules transformed.",
      "rendering chunks...",
      "computing gzip size...",
      "dist/index.js          12.34 kB │ gzip: 4.12 kB",
      "dist/assets/app.css     3.21 kB │ gzip: 1.05 kB",
      "✓ built in 1.23s",
      "Built dist/cli.mjs (48.2 KB)",
      "Tasks:    3 successful, 3 total",
      // Unknown line must stay verbatim
      "CUSTOM_DIAGNOSTIC_BANNER: schema checksum verified",
      // Test pass + Rust/Go/Gradle/Maven progress run (>= 4 lines)
      "✓ parses manifest (2ms)",
      "✔ loads workspace config (1ms)",
      "PASS test/unit.test.ts",
      "--- PASS: TestRouter (0.00s)",
      "ok\tgithub.com/org/repo/pkg\t0.14s",
      "test auth::verify_token ... ok",
      "Compiling serde v1.0.200",
      "Downloading crates ...",
      "> Task :core:compileKotlin UP-TO-DATE",
      "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0",
      // Short green run (< 4 lines) must NOT be folded
      "CUSTOM_BOUNDARY_LINE",
      "✓ tiny pass 1",
      "✓ tiny pass 2",
      "✓ tiny pass 3",
      // Final 15+ lines including the real TS failure
      ...Array.from({ length: 12 }, (_, i) => `context line ${i}`),
      "src/app.ts(18,7): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "  18 |   greet(42);",
      "     |         ^^",
      "Found 1 error in src/app.ts:18",
    ];
    const combined = viteAndMonorepoLines.join("\n");
    assert.ok(combined.length < 4000, `Fixture should be <= 4000 chars, got ${combined.length}`);

    const meta = formatCompactCommandOutputWithMeta({
      stdout: combined,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars: 4000,
    });

    assert.equal(meta.truncated, false);
    assert.equal(meta.rawLines, viteAndMonorepoLines.length);
    assert.equal(meta.rawChars, combined.length);
    assert.equal(meta.collapsedLines, 23);
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 13 build\/pass lines; last: Tasks:\s+3 successful, 3 total\)/,
    );
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 10 build\/pass lines; last: \[INFO\] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0\)/,
    );
    assert.doesNotMatch(meta.text, /rendering chunks/);
    assert.doesNotMatch(meta.text, /Compiling serde/);
    assert.match(meta.text, /CUSTOM_DIAGNOSTIC_BANNER: schema checksum verified/);
    assert.match(meta.text, /✓ tiny pass 1\n✓ tiny pass 2\n✓ tiny pass 3/);
    assert.match(meta.text, /error TS2345/);

    // 4 tiny lines whose placeholder would be LONGER than the original run must NOT expand
    const tinyRun = [
      "PASS a",
      "PASS b",
      "PASS c",
      "PASS d",
      ...Array.from({ length: 16 }, (_, i) => `tail ${i}`),
    ];
    const tinyRes = formatCompactCommandOutputWithMeta({
      stdout: tinyRun.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });
    assert.equal(tinyRes.collapsedLines, 0);
    assert.match(tinyRes.text, /PASS a\nPASS b\nPASS c\nPASS d/);
  });

  it("never folds [INFO] compiler/runtime/localized errors or warnings in parallel monorepo builds", () => {
    const lines = [
      "Scope: 4 of 4 workspace projects",
      "packages/pkg-a build$ tsc -b",
      "packages/pkg-a build: src/auth.ts(14,3): error TS2304: Cannot find name 'verifyJwt'.",
      "packages/pkg-a build: Failed",
      // pkg-b succeeds with a long green Vite build
      "packages/pkg-b build$ vite build",
      "packages/pkg-b build: vite v5.4.0 building for production...",
      "packages/pkg-b build: transforming...",
      "packages/pkg-b build: ✓ 28 modules transformed.",
      "packages/pkg-b build: rendering chunks...",
      "packages/pkg-b build: computing gzip size...",
      "packages/pkg-b build: dist/pkg-b.js  24.10 kB │ gzip: 7.40 kB",
      "packages/pkg-b build: ✓ built in 0.92s",
      "packages/pkg-b build: Done",
      "--- maven/compiler error verification phase ---",
      // Chinese javac/Maven [INFO] errors, Rust E0308, Unexpected, undefined, OOM, warnings MUST NEVER fold
      "[INFO] /repo/src/App.java:[14,12] 找不到符号",
      "[INFO] 符号: 方法 bar()",
      "[INFO] 位置: 类 App",
      "[INFO] 1 个错误",
      "[INFO] E0308: mismatched types",
      "[INFO] Unexpected token }",
      "[INFO] Cannot read properties of undefined",
      "[INFO] Process killed by signal SIGKILL (OOM)",
      "[INFO] Connection refused on port 5432",
      "[INFO] 2 warnings detected in deprecated API",
      // Trailing 15 lines
      ...Array.from({ length: 15 }, (_, i) => `packages/pkg-c summary line ${i}`),
    ];

    const meta = formatCompactCommandOutputWithMeta({
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });

    assert.equal(meta.truncated, false);
    assert.equal(meta.collapsedLines, 9);
    assert.match(meta.text, /packages\/pkg-a build: src\/auth\.ts\(14,3\): error TS2304/);
    assert.match(
      meta.text,
      /\.\.\. \(collapsed 9 build\/pass lines; last: packages\/pkg-b build: Done\)/,
    );
    assert.match(meta.text, /找不到符号/);
    assert.match(meta.text, /符号: 方法 bar\(\)/);
    assert.match(meta.text, /E0308: mismatched types/);
    assert.match(meta.text, /Unexpected token/);
    assert.match(meta.text, /Cannot read properties of undefined/);
    assert.match(meta.text, /SIGKILL \(OOM\)/);
    assert.match(meta.text, /Connection refused/);
    assert.match(meta.text, /2 warnings detected/);
  });

  it("never folds any of the final 15 lines of failure output", () => {
    const fifteenGreen = Array.from({ length: 15 }, (_, i) => `✓ passing spec ${i + 1}`);
    const res15 = formatCompactCommandOutputWithMeta({
      stdout: fifteenGreen.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });
    assert.equal(res15.collapsedLines, 0);
    assert.equal(res15.text, fifteenGreen.join("\n"));

    const twentyFiveGreen = Array.from({ length: 25 }, (_, i) => `✓ passing spec ${i + 1}`);
    const res25 = formatCompactCommandOutputWithMeta({
      stdout: twentyFiveGreen.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 4000,
    });
    assert.equal(res25.collapsedLines, 10);
    assert.match(
      res25.text,
      /\.\.\. \(collapsed 10 build\/pass lines; last: ✓ passing spec 10\)/,
    );
    for (let i = 11; i <= 25; i++) {
      assert.match(res25.text, new RegExp(`✓ passing spec ${i}(?:\\n|$)`));
    }
  });

  it("uses head-root + tail-priority compaction with [truncated: marker and surrogate safety", () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `dist/assets/chunk-${i}.js   10.${i} kB │ gzip: 3.1 kB`),
      "src/core.ts(10,1): error TS2304: FIRST_ROOT_CAUSE_MISSING_SYMBOL",
      "  10 | export const broken = FIRST_ROOT_CAUSE_MISSING_SYMBOL;",
      ...Array.from(
        { length: 80 },
        (_, i) => `src/cascade-${i}.ts(${i + 1},5): error TS2322: cascade failure padding ${"x".repeat(35)}`,
      ),
      "src/final.ts(99,9): error TS2345: FINAL_TAIL_FAILURE_MARKER",
      "Found 82 errors in 82 files.",
    ];

    const maxChars = 1000;
    const meta = formatCompactCommandOutputWithMeta({
      stdout: lines.join("\n"),
      stderr: "",
      exitCode: 2,
      timedOut: false,
      maxChars,
    });

    assert.equal(meta.truncated, true);
    assert.equal(meta.collapsedLines, 20);
    assert.ok(meta.text.length <= maxChars, `Expected <= ${maxChars}, got ${meta.text.length}`);
    assert.match(meta.text, /FIRST_ROOT_CAUSE_MISSING_SYMBOL/);
    assert.match(meta.text, /FINAL_TAIL_FAILURE_MARKER/);
    assert.match(meta.text, /Found 82 errors in 82 files\./);
    assert.match(meta.text, /\[truncated: \d+ lines omitted\]/);

    const emojiLog = [
      `Error: ${"🚀".repeat(200)} FIRST_EMOJI_ERR`,
      ...Array.from({ length: 40 }, (_, i) => `Error: middle ${i} ${"🔥".repeat(40)}`),
      `Error: ${"💥".repeat(120)} TAIL_EMOJI_END`,
    ].join("\n");
    const emojiMeta = formatCompactCommandOutputWithMeta({
      stdout: emojiLog,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 350,
    });
    assert.equal(emojiMeta.truncated, true);
    assert.ok(emojiMeta.text.length <= 350);
    assert.match(emojiMeta.text, /TAIL_EMOJI_END/);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiMeta.text),
      false,
    );
  });

  it("reports accurate metadata across pass, spawn error, timeout (head-tail), and tiny maxChars", () => {
    const passMeta = formatCompactCommandOutputWithMeta({
      stdout: "line 1\nAll 42 tests passed\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      maxChars: 500,
    });
    assert.equal(passMeta.text, "All 42 tests passed");
    assert.equal(passMeta.collapsedLines, 0);
    assert.equal(passMeta.truncated, false);
    assert.equal(passMeta.rawLines, 2);
    assert.equal(passMeta.rawChars, "line 1\nAll 42 tests passed".length);

    // Tiny maxChars on empty exit 0 respects limit
    assert.equal(
      formatCompactCommandOutput({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        maxChars: 1,
      }),
      "O",
    );

    const errMeta = formatCompactCommandOutputWithMeta({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "ENOENT",
      maxChars: 500,
    });
    assert.equal(errMeta.text, "spawn error: ENOENT");
    assert.equal(errMeta.truncated, false);

    // Timeout preserves TIMED OUT header AND final hang-point tail even when 20 lines > maxChars
    const timeoutMeta = formatCompactCommandOutputWithMeta({
      stdout: Array.from(
        { length: 30 },
        (_, i) => `tick ${i} ${"p".repeat(60)}${i === 29 ? " HANG_POINT_TAIL" : ""}`,
      ).join("\n"),
      stderr: "",
      exitCode: null,
      timedOut: true,
      maxChars: 420,
    });
    assert.equal(timeoutMeta.collapsedLines, 0);
    assert.equal(timeoutMeta.truncated, true);
    assert.ok(timeoutMeta.text.length <= 420);
    assert.match(timeoutMeta.text, /^TIMED OUT\n/);
    assert.match(timeoutMeta.text, /HANG_POINT_TAIL/);
  });

  it("handles oversized single-line errors and donates unused tail budget when followed by short trailing lines", () => {
    const singleLine = `Error: ${"a".repeat(450)} REAL_CAUSE_AT_END`;
    const resSingle = formatCompactCommandOutputWithMeta({
      stdout: singleLine,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 300,
    });
    assert.equal(resSingle.truncated, true);
    assert.ok(resSingle.text.length <= 300 && resSingle.text.length >= 260, `got ${resSingle.text.length}`);
    assert.match(resSingle.text, /^Error: a+/);
    assert.match(resSingle.text, /\[truncated: folded \d+ chars\]/);
    assert.match(resSingle.text, /REAL_CAUSE_AT_END$/);

    // Oversized first error line followed by a short trailing line must NOT waste 70% of budget
    const withShortTail = `${`Error: ${"a".repeat(1200)} REAL_CAUSE_AT_END`}\nnpm ERR! code 1`;
    const resShortTail = formatCompactCommandOutputWithMeta({
      stdout: withShortTail,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 900,
    });
    assert.equal(resShortTail.truncated, true);
    assert.ok(resShortTail.text.length <= 900 && resShortTail.text.length >= 820, `got ${resShortTail.text.length}`);
    assert.match(resShortTail.text, /^Error: a+/);
    assert.match(resShortTail.text, /REAL_CAUSE_AT_END/);
    assert.match(resShortTail.text, /npm ERR! code 1$/);

    // Two consecutive oversized error lines (both > maxChars) preserve BOTH first head AND second tail
    const twoGiants = [
      `Error: FIRST_GIANT_HEAD ${"a".repeat(600)}`,
      `Error: ${"b".repeat(600)} SECOND_GIANT_TAIL`,
    ].join("\n");
    const resTwoGiants = formatCompactCommandOutputWithMeta({
      stdout: twoGiants,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 300,
    });
    assert.equal(resTwoGiants.truncated, true);
    assert.ok(resTwoGiants.text.length <= 300);
    assert.match(resTwoGiants.text, /FIRST_GIANT_HEAD/);
    assert.match(resTwoGiants.text, /SECOND_GIANT_TAIL/);
    assert.match(resTwoGiants.text, /\[truncated:/);

    // Same oversized error line preceded by 50 neutral lines
    const withPrefix = [
      ...Array.from({ length: 50 }, (_, i) => `neutral step ${i}`),
      singleLine,
    ].join("\n");
    const resPrefixed = formatCompactCommandOutputWithMeta({
      stdout: withPrefix,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 300,
    });
    assert.equal(resPrefixed.truncated, true);
    assert.ok(resPrefixed.text.length <= 300);
    assert.match(resPrefixed.text, /\[truncated: 50 lines omitted\]/);
    assert.match(resPrefixed.text, /Error: a+/);
    assert.match(resPrefixed.text, /REAL_CAUSE_AT_END$/);

    // Surrogate safety when splitting an emoji-heavy single oversized error line
    const emojiSingle = `Error: ${"🚀".repeat(250)} END_ROCKET`;
    const resEmoji = formatCompactCommandOutput({
      stdout: emojiSingle,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 240,
    });
    assert.ok(resEmoji.length <= 240);
    assert.match(resEmoji, /END_ROCKET$/);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(resEmoji),
      false,
    );
  });

  it("stays linear-time (no quadratic ReDoS) on adversarial 60K-char inputs", () => {
    const adversarialLines = [
      `asset ${"a".repeat(60_000)}`,
      `Tests${" ".repeat(60_000)}X`,
      `Tests ${"1".repeat(60_000)}X`,
      `built ${"(".repeat(25_000)}${" ".repeat(25_000)}X`,
      `${"⎯".repeat(50_000)}x`,
      ...Array.from({ length: 16 }, (_, i) => `tail line ${i}`),
    ];

    const start = performance.now();
    const res = formatCompactCommandOutputWithMeta({
      stdout: adversarialLines.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 1000,
    });
    const elapsedMs = performance.now() - start;

    assert.ok(elapsedMs < 500, `Expected linear-time < 500ms on adversarial input, took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(res.text.length <= 1000);
    assert.match(res.text, /tail line 15/);
  });

  it("folds passing test lines containing error-domain words without hiding actual mid-suite failures, and drops ANSI-erased spinner lines", () => {
    const spinnerRaw =
      "⠋ Transforming (12/140)...\r\x1B[2K\n⠙ Bundling chunks...\r\x1B[K\n⠹ Resolving...\r\x1B[2K✓ Built client\n\nReal error: boom";
    assert.equal(normalizeTerminalOutput(spinnerRaw), "✓ Built client\n\nReal error: boom");

    const suiteLines = [
      ...Array.from(
        { length: 40 },
        (_, i) =>
          `✔ test #${i + 1}: handles invalid error, undefined input, not found, and timeout cleanly (1.2ms)`,
      ),
      "✖ ACTUAL_FAILING_TEST_AT_MIDPOINT (4.8ms)",
      "  AssertionError [ERR_ASSERTION]: Expected status 200 but received 500",
      ...Array.from(
        { length: 30 },
        (_, i) => `      at Layer.handle (/repo/src/router/frame_${i}.ts:${i + 10}:15)`,
      ),
      "ℹ tests 41",
      "ℹ pass 40",
      "ℹ fail 1",
    ];
    const meta = formatCompactCommandOutputWithMeta({
      stdout: suiteLines.join("\n"),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 950,
    });
    assert.equal(meta.collapsedLines, 40);
    assert.match(meta.text, /collapsed 40 build\/pass lines/);
    assert.match(meta.text, /ACTUAL_FAILING_TEST_AT_MIDPOINT/);
    assert.match(meta.text, /AssertionError \[ERR_ASSERTION\]/);
    assert.match(meta.text, /ℹ fail 1/);
  });

  it("formats fatal signal names and shell 128+N exit diagnostics cleanly", () => {
    assert.equal(formatExitFailureLabel(null, "SIGKILL"), "SIGKILL - possible OOM");
    assert.equal(formatExitFailureLabel(null, "SIGSEGV"), "SIGSEGV - segmentation fault");
    assert.equal(formatExitFailureLabel(null, "SIGABRT"), "SIGABRT - process aborted");
    assert.equal(formatExitFailureLabel(null, "SIGTERM"), "SIGTERM");
    assert.equal(formatExitFailureLabel(null, "SIGBUS"), "SIGBUS");

    assert.equal(formatExitFailureLabel(137, null), "exit 137 / SIGKILL - possible OOM");
    assert.equal(formatExitFailureLabel(139, null), "exit 139 / SIGSEGV - segmentation fault");
    assert.equal(formatExitFailureLabel(134, null), "exit 134 / SIGABRT - process aborted");
    assert.equal(formatExitFailureLabel(0xc0000005, null), "exit 0xC0000005 / STATUS_ACCESS_VIOLATION");
    assert.equal(formatExitFailureLabel(-1073741819, null), "exit 0xC0000005 / STATUS_ACCESS_VIOLATION");
    assert.equal(formatExitFailureLabel(0xc00000fd, null), "exit 0xC00000FD / STATUS_STACK_OVERFLOW");
    assert.equal(formatExitFailureLabel(0xc0000409, null), "exit 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN");
    assert.equal(formatExitFailureLabel(1, null), "exit 1");
    assert.equal(formatExitFailureLabel(null, null), "exit err");

    const sigkillEmpty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
    });
    assert.equal(sigkillEmpty.kind, "fail-empty");
    assert.equal(sigkillEmpty.bodyText, "Terminated by SIGKILL - possible OOM");

    const sigsegvEmpty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: "SIGSEGV",
      timedOut: false,
    });
    assert.equal(sigsegvEmpty.bodyText, "Terminated by SIGSEGV - segmentation fault");

    const exit137Empty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: 137,
      signal: null,
      timedOut: false,
    });
    assert.equal(exit137Empty.bodyText, "Terminated (exit 137 / SIGKILL - possible OOM)");

    const exit139Empty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: 139,
      signal: null,
      timedOut: false,
    });
    assert.equal(exit139Empty.bodyText, "Terminated (exit 139 / SIGSEGV - segmentation fault)");

    const exit134Empty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: 134,
      signal: null,
      timedOut: false,
    });
    assert.equal(exit134Empty.bodyText, "Terminated (exit 134 / SIGABRT - process aborted)");

    const ntstatusEmpty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: 0xc0000005,
      signal: null,
      timedOut: false,
    });
    assert.equal(ntstatusEmpty.bodyText, "Terminated (exit 0xC0000005 / STATUS_ACCESS_VIOLATION)");

    const unknownEmpty = prepareCompactCommandOutput({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
    });
    assert.equal(unknownEmpty.bodyText, "Exited with code unknown");
  });

  it("denoises Python pytest/mypy/ruff/tqdm logs while preserving tracebacks and failures", () => {
    const pythonFailureLog = [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.11.9, pytest-8.2.0, pluggy-1.5.0",
      "cachedir: .pytest_cache",
      "rootdir: /repo",
      "configfile: pyproject.toml",
      "plugins: cov-5.0.0, asyncio-0.23.6",
      "collecting ...",
      "collected 48 items",
      "tests/test_alpha.py ..........                                          [ 20%]",
      "tests/test_errors.py::test_handle_error_payload PASSED                  [ 25%]",
      "tests/test_beta.py::test_retry_backoff SKIPPED                          [ 27%]",
      ".................................                                        [ 90%]",
      "  0%|          | 0/100 [00:00<?, ?it/s]",
      "Fetching bars: 100%|██████████| 100/100 [00:01<00:00, 92.34it/s]",
      "123it [00:01, 100.23it/s]",
      "[*] 3 fixable with the `--fix` option.",
      "No fixes available (2 hidden fixes can be enabled with the `--unsafe-fixes` option).",
      "src/app.py:12: note: See https://mypy.readthedocs.io/en/stable/common_issues.html",
      "tests/test_gamma.py ..F.                                                [100%]",
      "=================================== FAILURES ===================================",
      "_____________________________ test_compute_signal ______________________________",
      "Traceback (most recent call last):",
      '  File "tests/test_gamma.py", line 42, in test_compute_signal',
      "    assert compute(0) == 1",
      "ValueError: invalid window size 0",
      "src/app.py:18:4: F401 'os' imported but unused",
      ...Array.from({ length: 15 }, (_, i) => `summary tail line ${i}`),
    ].join("\n");

    const meta = formatCompactCommandOutputWithMeta({
      stdout: pythonFailureLog,
      stderr: "",
      exitCode: 1,
      timedOut: false,
      maxChars: 8800,
    });

    assert.equal(meta.truncated, false);
    assert.ok(meta.collapsedLines >= 12, `Expected pytest header+pass lines folded, got ${meta.collapsedLines}`);
    assert.doesNotMatch(meta.text, /Fetching bars: 100%/);
    assert.doesNotMatch(meta.text, /123it \[00:01/);
    assert.doesNotMatch(meta.text, /fixable with the `--fix` option/);
    assert.doesNotMatch(meta.text, /mypy\.readthedocs\.io/);
    // Real failures (including F in dots, traceback, ValueError, ruff F401) must be preserved
    assert.match(meta.text, /tests\/test_gamma\.py \.\.F\./);
    assert.match(meta.text, /Traceback \(most recent call last\):/);
    assert.match(meta.text, /ValueError: invalid window size 0/);
    assert.match(meta.text, /F401 'os' imported but unused/);

    // Passing mypy summary should be picked cleanly on exitCode === 0
    const mypyPass = formatCompactCommandOutput({
      stdout: "Success: no issues found in 42 source files",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      maxChars: 8800,
    });
    assert.equal(mypyPass, "Success: no issues found in 42 source files");
  });
});
