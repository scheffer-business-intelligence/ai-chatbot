#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_MODEL = "google/scheffer-agent-engine";
const DEFAULT_RUNS = 8;
const DEFAULT_WARMUP = 2;
const DEFAULT_PROMPTS_FILE = "scripts/bench/prompts.json";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith("--")) {
      continue;
    }

    const withoutPrefix = current.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      args[key] = value;
      continue;
    }

    const key = withoutPrefix;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = "true";
    }
  }

  return args;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/bench/chat-latency.mjs \\",
    "    --new-base-url https://new.example.com \\",
    "    --legacy-base-url https://legacy.example.com \\",
    "    --new-cookie 'auth_cookie_for_new' \\",
    "    --legacy-cookie 'auth_cookie_for_legacy' \\",
    "    [--model google/scheffer-agent-engine] \\",
    "    [--runs 8] \\",
    "    [--warmup 2] \\",
    "    [--prompts-file scripts/bench/prompts.json]",
  ].join("\n");
}

async function loadPrompts(promptsFilePath) {
  const raw = await readFile(promptsFilePath, "utf-8");
  const parsed = JSON.parse(raw);

  const prompts = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.prompts)
      ? parsed.prompts
      : [];

  const normalized = prompts
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error(`No prompts found in ${promptsFilePath}`);
  }

  return normalized;
}

function readSseFramesFromBuffer(state) {
  const frames = [];
  let boundaryIndex = state.buffer.indexOf("\n\n");

  while (boundaryIndex >= 0) {
    frames.push(state.buffer.slice(0, boundaryIndex));
    state.buffer = state.buffer.slice(boundaryIndex + 2);
    boundaryIndex = state.buffer.indexOf("\n\n");
  }

  return frames;
}

function parseSseFrame(frame) {
  const dataLines = [];

  for (const line of frame.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith(":")) {
      continue;
    }

    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.replace(/^data:\s?/, ""));
    }
  }

  if (dataLines.length === 0) {
    return [];
  }

  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function average(values) {
  if (values.length === 0) {
    return null;
  }

  const sum = values.reduce((accumulator, current) => accumulator + current, 0);
  return Number((sum / values.length).toFixed(2));
}

function summarizeResults(results) {
  const measured = results.filter((result) => !result.warmup);
  const successful = measured.filter((result) => result.ok);

  const ttftValues = successful
    .map((result) => result.ttft_ms)
    .filter((value) => Number.isFinite(value));
  const totalValues = successful
    .map((result) => result.total_ms)
    .filter((value) => Number.isFinite(value));

  return {
    runs: measured.length,
    successful_runs: successful.length,
    failed_runs: measured.length - successful.length,
    error_rate_pct:
      measured.length > 0
        ? Number(
            (
              ((measured.length - successful.length) / measured.length) *
              100
            ).toFixed(2)
          )
        : null,
    ttft_ms: {
      avg: average(ttftValues),
      p50: percentile(ttftValues, 50),
      p90: percentile(ttftValues, 90),
      p95: percentile(ttftValues, 95),
    },
    total_ms: {
      avg: average(totalValues),
      p50: percentile(totalValues, 50),
      p90: percentile(totalValues, 90),
      p95: percentile(totalValues, 95),
    },
  };
}

function improvementPct(newValue, legacyValue) {
  if (!Number.isFinite(newValue) || !Number.isFinite(legacyValue)) {
    return null;
  }

  if (legacyValue <= 0) {
    return null;
  }

  return Number((((legacyValue - newValue) / legacyValue) * 100).toFixed(2));
}

function buildComparison(newSummary, legacySummary) {
  return {
    ttft_ms: {
      avg_improvement_pct: improvementPct(
        newSummary.ttft_ms.avg,
        legacySummary.ttft_ms.avg
      ),
      p50_improvement_pct: improvementPct(
        newSummary.ttft_ms.p50,
        legacySummary.ttft_ms.p50
      ),
      p90_improvement_pct: improvementPct(
        newSummary.ttft_ms.p90,
        legacySummary.ttft_ms.p90
      ),
      p95_improvement_pct: improvementPct(
        newSummary.ttft_ms.p95,
        legacySummary.ttft_ms.p95
      ),
    },
    total_ms: {
      avg_improvement_pct: improvementPct(
        newSummary.total_ms.avg,
        legacySummary.total_ms.avg
      ),
      p50_improvement_pct: improvementPct(
        newSummary.total_ms.p50,
        legacySummary.total_ms.p50
      ),
      p90_improvement_pct: improvementPct(
        newSummary.total_ms.p90,
        legacySummary.total_ms.p90
      ),
      p95_improvement_pct: improvementPct(
        newSummary.total_ms.p95,
        legacySummary.total_ms.p95
      ),
    },
  };
}

async function runSingleRequest({
  endpointLabel,
  baseUrl,
  cookie,
  model,
  prompt,
  runIndex,
  warmup,
}) {
  const chatId = randomUUID();
  const messageId = randomUUID();
  const startAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        id: chatId,
        selectedChatModel: model,
        message: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        endpoint: endpointLabel,
        run_index: runIndex,
        warmup,
        prompt,
        ok: false,
        http_status: response.status,
        ttft_ms: null,
        total_ms: Number((performance.now() - startAt).toFixed(2)),
        finish_seen: false,
        error: errorText.slice(0, 600),
      };
    }

    if (!response.body) {
      return {
        endpoint: endpointLabel,
        run_index: runIndex,
        warmup,
        prompt,
        ok: false,
        http_status: response.status,
        ttft_ms: null,
        total_ms: Number((performance.now() - startAt).toFixed(2)),
        finish_seen: false,
        error: "Response body is empty.",
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { buffer: "" };
    let ttftMs = null;
    let finishSeen = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      state.buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      for (const frame of readSseFramesFromBuffer(state)) {
        for (const eventPart of parseSseFrame(frame)) {
          if (!eventPart || typeof eventPart !== "object") {
            continue;
          }

          if (eventPart.type === "text-delta") {
            const delta =
              typeof eventPart.delta === "string" ? eventPart.delta : "";
            if (delta.trim() && ttftMs === null) {
              ttftMs = Number((performance.now() - startAt).toFixed(2));
            }
          }

          if (eventPart.type === "finish") {
            finishSeen = true;
          }
        }
      }
    }

    return {
      endpoint: endpointLabel,
      run_index: runIndex,
      warmup,
      prompt,
      ok: true,
      http_status: response.status,
      ttft_ms: ttftMs,
      total_ms: Number((performance.now() - startAt).toFixed(2)),
      finish_seen: finishSeen,
      error: null,
    };
  } catch (error) {
    return {
      endpoint: endpointLabel,
      run_index: runIndex,
      warmup,
      prompt,
      ok: false,
      http_status: null,
      ttft_ms: null,
      total_ms: Number((performance.now() - startAt).toFixed(2)),
      finish_seen: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const newBaseUrl = args["new-base-url"];
  const legacyBaseUrl = args["legacy-base-url"];
  const newCookie = args["new-cookie"];
  const legacyCookie = args["legacy-cookie"];

  if (!newBaseUrl || !legacyBaseUrl || !newCookie || !legacyCookie) {
    console.error(usage());
    process.exit(1);
  }

  const model = args.model || DEFAULT_MODEL;
  const runs = toPositiveInt(args.runs, DEFAULT_RUNS);
  const warmup = toPositiveInt(args.warmup, DEFAULT_WARMUP);
  const promptsFile = resolve(
    process.cwd(),
    args["prompts-file"] || DEFAULT_PROMPTS_FILE
  );

  const prompts = await loadPrompts(promptsFile);
  const totalIterations = warmup + runs;
  const endpoints = {
    new: {
      label: "new",
      baseUrl: normalizeBaseUrl(newBaseUrl),
      cookie: newCookie,
    },
    legacy: {
      label: "legacy",
      baseUrl: normalizeBaseUrl(legacyBaseUrl),
      cookie: legacyCookie,
    },
  };

  const allResults = [];

  for (const prompt of prompts) {
    for (let runIndex = 0; runIndex < totalIterations; runIndex += 1) {
      const warmupRun = runIndex < warmup;
      const endpointOrder =
        runIndex % 2 === 0
          ? [endpoints.new, endpoints.legacy]
          : [endpoints.legacy, endpoints.new];

      for (const endpoint of endpointOrder) {
        const result = await runSingleRequest({
          endpointLabel: endpoint.label,
          baseUrl: endpoint.baseUrl,
          cookie: endpoint.cookie,
          model,
          prompt,
          runIndex,
          warmup: warmupRun,
        });

        allResults.push(result);

        const runLabel = warmupRun ? "warmup" : "measured";
        const ttftLabel =
          result.ttft_ms === null ? "n/a" : `${result.ttft_ms} ms`;
        const totalLabel = `${result.total_ms} ms`;
        const statusLabel = result.ok ? "ok" : `error (${result.http_status ?? "-"})`;
        console.log(
          `[${endpoint.label}] prompt="${prompt.slice(0, 48)}" run=${runIndex + 1}/${totalIterations} ${runLabel} status=${statusLabel} ttft=${ttftLabel} total=${totalLabel}`
        );
      }
    }
  }

  const newResults = allResults.filter((result) => result.endpoint === "new");
  const legacyResults = allResults.filter(
    (result) => result.endpoint === "legacy"
  );

  const newSummary = summarizeResults(newResults);
  const legacySummary = summarizeResults(legacyResults);
  const comparison = buildComparison(newSummary, legacySummary);

  const report = {
    generated_at: new Date().toISOString(),
    config: {
      model,
      prompts_file: promptsFile,
      prompts_count: prompts.length,
      warmup_runs_per_prompt: warmup,
      measured_runs_per_prompt: runs,
      endpoints: {
        new: endpoints.new.baseUrl,
        legacy: endpoints.legacy.baseUrl,
      },
    },
    summaries: {
      new: newSummary,
      legacy: legacySummary,
      improvement_vs_legacy_pct: comparison,
    },
    results: allResults,
  };

  const outputDir = resolve(process.cwd(), "artifacts", "bench");
  await mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(outputDir, `chat-latency-${timestamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  console.log("\nBenchmark summary:");
  console.log(`- New endpoint p50 TTFT: ${newSummary.ttft_ms.p50 ?? "n/a"} ms`);
  console.log(
    `- Legacy endpoint p50 TTFT: ${legacySummary.ttft_ms.p50 ?? "n/a"} ms`
  );
  console.log(
    `- TTFT p50 improvement vs legacy: ${comparison.ttft_ms.p50_improvement_pct ?? "n/a"}%`
  );
  console.log(`- New endpoint p50 total: ${newSummary.total_ms.p50 ?? "n/a"} ms`);
  console.log(
    `- Legacy endpoint p50 total: ${legacySummary.total_ms.p50 ?? "n/a"} ms`
  );
  console.log(
    `- Total p50 improvement vs legacy: ${comparison.total_ms.p50_improvement_pct ?? "n/a"}%`
  );
  console.log(`\nReport saved to: ${outputPath}`);
}

main().catch((error) => {
  console.error("Failed to run chat latency benchmark:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
