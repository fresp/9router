import { NextResponse } from "next/server";
import { getDistinctCombos } from "@/lib/requestDetailsDb";

/**
 * GET /api/usage/combos
 * Returns the combos that appear in request details, for the Details tab filter.
 */
export async function GET() {
  try {
    const combos = await getDistinctCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.error("[API] Failed to get combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}
