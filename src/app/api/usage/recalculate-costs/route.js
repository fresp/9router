import { NextResponse } from "next/server";
import { recalculateUsageCosts } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// Fill in costs for history rows recorded at $0 whose model has pricing now,
// and rebuild the daily rollups from history. Idempotent; never lowers a cost.
export async function POST() {
  try {
    const result = await recalculateUsageCosts();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[API] Failed to recalculate usage costs:", error);
    return NextResponse.json({ error: "Failed to recalculate usage costs" }, { status: 500 });
  }
}
