import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, deleteModelAlias, getComboByName } from "@/models";
import { isReservedProviderPrefix } from "@/sse/services/model.js";
import { validateModelAliasName } from "@/shared/utils/modelAlias.js";

export const dynamic = "force-dynamic";

// GET /api/models/alias - Get all aliases
export async function GET() {
  try {
    const aliases = await getModelAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const alias = typeof body?.alias === "string" ? body.alias.trim() : "";

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const aliasError = validateModelAliasName(alias);
    if (aliasError) {
      return NextResponse.json({ error: aliasError }, { status: 400 });
    }

    // Target must be `provider/model`; a bare target would chain alias → alias.
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      return NextResponse.json({ error: "Model must be in provider/model format" }, { status: 400 });
    }

    // Names the router resolves before (combos) or instead of (provider-as-model
    // for search/fetch) the alias map would make the alias dead or ambiguous.
    if (isReservedProviderPrefix(alias)) {
      return NextResponse.json({ error: `"${alias}" is a built-in provider name` }, { status: 409 });
    }
    if (await getComboByName(alias)) {
      return NextResponse.json({ error: `A combo named "${alias}" already exists` }, { status: 409 });
    }

    // Re-pointing an alias silently reroutes every client using it — require
    // an explicit delete first.
    const existing = (await getModelAliases())[alias];
    if (existing && existing !== model) {
      return NextResponse.json({ error: `Alias "${alias}" already points to ${existing}` }, { status: 409 });
    }

    await setModelAlias(alias, model);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
