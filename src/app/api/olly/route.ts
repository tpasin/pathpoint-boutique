// @pathpoint-source panel:olly
import { NextRequest, NextResponse } from "next/server";
import { askOlly } from "@/lib/coralogix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STAGE_PROMPTS: Record<string, string> = {
  browse:
    "For astronomy-demo Online Boutique, analyze BROWSE health (frontend product APIs, product-catalog, recommendations). Summarize error rates, top failing operations, and likely root cause. Keep it concise with bullets.",
  cart: "For astronomy-demo Online Boutique, analyze CART health (cart service, Redis, AddItemAsync). Summarize Redis/connection errors and impact on checkout. Keep it concise with bullets.",
  checkout:
    "For astronomy-demo Online Boutique, analyze CHECKOUT health (POST /api/checkout, PlaceOrder). Summarize 500 rate, related payment failures, and recommended next queries. Keep it concise with bullets.",
  payment:
    "For astronomy-demo Online Boutique, analyze PAYMENT health (Charge / payment service). Summarize failure modes (invalid token, NaN amount, postgres) and impact on checkout. Keep it concise with bullets.",
  fulfill:
    "For astronomy-demo Online Boutique, analyze FULFILL health (EmptyCart, shipping, email). Summarize FAILED_PRECONDITION / latency and whether paid orders still complete. Keep it concise with bullets.",
  journey:
    "For astronomy-demo Online Boutique, give a Pathpoint-style journey health brief across Browse → Cart → Checkout → Payment → Fulfill. Call out the critical stages and one recommended investigation step each. Keep it concise.",
};

type BoxContext = {
  kind?: string;
  label?: string;
  metric?: string;
  light?: string;
  stageId?: string;
  exploreKind?: string;
  exploreQuery?: string;
  extra?: string;
};

function buildBoxPrompt(box: BoxContext, question: string, window: string): string {
  const parts = [
    "You are helping investigate the astronomy-demo Online Boutique Pathpoint journey.",
    `Pathpoint box: kind=${box.kind || "unknown"}, label="${box.label || "unknown"}".`,
  ];
  if (box.metric) parts.push(`Current metric/value shown: ${box.metric}.`);
  if (box.light) parts.push(`Traffic light: ${box.light}.`);
  if (box.stageId) parts.push(`Stage id: ${box.stageId}.`);
  if (box.exploreQuery) {
    parts.push(
      `Related Coralogix DataPrime (${box.exploreKind || "query"}): ${box.exploreQuery}`
    );
  }
  if (box.extra) parts.push(`Extra: ${box.extra}.`);
  parts.push(window);
  parts.push(`User question: ${question}`);
  parts.push(
    "Answer using live Coralogix data when possible. Be concise with bullets and concrete next steps."
  );
  return parts.join(" ");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      message?: string;
      chatId?: string;
      model?: string;
      stage?: string;
      start?: string;
      end?: string;
      box?: BoxContext;
    };

    const stage = body.stage || "";
    const preset = STAGE_PROMPTS[stage];
    const userMessage = (body.message || "").trim();
    const window =
      body.start && body.end
        ? ` Time window: ${body.start} → ${body.end}.`
        : " Focus on the last hour.";

    let message = "";
    if (body.box && (userMessage || body.box.label)) {
      message = buildBoxPrompt(
        body.box,
        userMessage ||
          `What is the health of ${body.box.label}, and what should I investigate next?`,
        window
      );
    } else if (userMessage) {
      message = userMessage;
    } else if (preset) {
      message = `${preset}${window}`;
    }

    if (!message) {
      return NextResponse.json(
        {
          error:
            "Provide message, box context, or a known stage (browse|cart|checkout|payment|fulfill|journey)",
        },
        { status: 400 }
      );
    }

    const result = await askOlly({
      message,
      chatId: body.chatId,
      model: body.model || process.env["CX_OLLY_MODEL"] || "claude-haiku-4-5",
      timeoutSec: Number(process.env["CX_OLLY_TIMEOUT"] || 180),
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
