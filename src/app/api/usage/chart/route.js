import { NextResponse } from "next/server";
import { getChartData, getApiKeyChartData } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    // groupBy=apiKey → one series per caller API key (identified by id/masked key only)
    const groupBy = searchParams.get("groupBy");
    if (groupBy && groupBy !== "apiKey") {
      return NextResponse.json({ error: "Invalid groupBy" }, { status: 400 });
    }

    // Viewer's Date#getTimezoneOffset, so "today" starts at their midnight rather than the server's.
    const tzRaw = searchParams.get("tzOffset");
    const tzOffsetMinutes = tzRaw !== null && /^-?\d{1,3}$/.test(tzRaw) && Math.abs(Number(tzRaw)) <= 840 ? Number(tzRaw) : undefined;
    const opts = { tzOffsetMinutes };

    const data = groupBy === "apiKey" ? await getApiKeyChartData(period, opts) : await getChartData(period, opts);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
