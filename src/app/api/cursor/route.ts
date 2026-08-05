import { NextRequest, NextResponse } from "next/server";
import {
  askCursor,
  cursorConfigured,
  cursorEnabled,
  cursorRuntime,
} from "@/lib/cursor-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const configured = cursorConfigured();
  const enabled = cursorEnabled();
  return NextResponse.json({
    configured,
    enabled,
    runtime: cursorRuntime(),
    model: process.env["CURSOR_MODEL"] || "composer-2.5",
    cwd:
      process.env["CURSOR_AGENT_CWD"] ||
      (cursorRuntime() === "local" ? process.cwd() : undefined),
    cloudRepo: process.env["CURSOR_CLOUD_REPO"] || undefined,
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!cursorConfigured()) {
      return NextResponse.json(
        {
          error:
            "CURSOR_API_KEY is not set on the server. Add it to the Pathpoint env and restart.",
        },
        { status: 503 }
      );
    }

    if (!cursorEnabled()) {
      return NextResponse.json(
        {
          error:
            "Cursor agent is temporarily disabled (CURSOR_ENABLED=false). Set CURSOR_ENABLED=true to re-enable.",
        },
        { status: 503 }
      );
    }

    const body = (await req.json()) as {
      message?: string;
      agentId?: string;
      start?: string;
      end?: string;
      stage?: string;
    };

    const message = (body.message || "").trim();
    if (!message) {
      return NextResponse.json({ error: "Provide a message" }, { status: 400 });
    }

    const result = await askCursor({
      message,
      agentId: body.agentId || undefined,
      start: body.start,
      end: body.end,
      stage: body.stage,
    });

    if (result.status === "error") {
      return NextResponse.json(result, { status: 502 });
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
