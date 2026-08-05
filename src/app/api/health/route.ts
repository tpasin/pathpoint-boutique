import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

/** Runtime probe for deploy diagnostics (no secrets in response). */
export async function GET() {
  const cxBin = process.env["CX_BIN"] || "cx";
  const hasKey = Boolean(process.env["CX_API_KEY"]);
  const hasProfile = Boolean(process.env["CX_PROFILE"]);
  const region = process.env["CX_REGION"] || "";
  const maxConcurrent = process.env["CX_MAX_CONCURRENT"] || "";
  const tier = process.env["CX_TIER"] || "";

  let cxVersion = "";
  let probe: { ok: boolean; rowCount?: number; error?: string } = { ok: false };

  try {
    const { stdout } = await execFileAsync(cxBin, ["--version"], {
      timeout: 10_000,
      env: { ...process.env },
    });
    cxVersion = stdout.trim().split("\n")[0] || "";
  } catch (err) {
    cxVersion = err instanceof Error ? err.message : String(err);
  }

  if (hasKey || hasProfile) {
    try {
      const args = hasProfile
        ? ["--profile", process.env["CX_PROFILE"]!, "dataprime", "query"]
        : [
            "--api-key",
            process.env["CX_API_KEY"]!,
            ...(region ? ["--region", region] : []),
            "dataprime",
            "query",
          ];
      if (tier) args.push("--tier", tier);
      args.push(
        "--start",
        "now-15m",
        "--end",
        "now",
        "--limit",
        "1",
        "-o",
        "json",
        "source spans | filter $l.applicationName == 'astronomy-demo' | limit 1"
      );
      const { stdout } = await execFileAsync(cxBin, args, {
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
      });
      const trimmed = stdout.trim();
      const start = trimmed.indexOf("[");
      const json = start >= 0 ? trimmed.slice(start) : trimmed;
      const parsed = JSON.parse(json);
      const rows = Array.isArray(parsed) ? parsed : [];
      probe = { ok: true, rowCount: rows.length };
    } catch (err) {
      probe = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json({
    ok: hasKey || hasProfile,
    hasKey,
    hasProfile,
    regionSet: Boolean(region),
    regionHost: region.replace(/^https?:\/\//, "").slice(0, 40),
    maxConcurrent,
    tier,
    cxBin,
    cxVersion,
    probe,
  });
}
