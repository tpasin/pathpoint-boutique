import { NextRequest, NextResponse } from "next/server";
import { buildK8sSnapshot } from "@/lib/k8s";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const stage = searchParams.get("stage");
    const step = searchParams.get("step");
    const label = searchParams.get("label");

    const snapshot = await buildK8sSnapshot({ stage, step, label });
    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
