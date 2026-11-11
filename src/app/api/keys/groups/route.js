import { NextResponse } from "next/server";
import { getApiKeyGroups, createApiKeyGroup } from "@/lib/localDb";
import { validateKeyGroupName } from "@/shared/utils/apiKeyGroup.js";

export const dynamic = "force-dynamic";

// GET /api/keys/groups - List API key groups
export async function GET() {
  try {
    const groups = await getApiKeyGroups();
    return NextResponse.json({ groups });
  } catch (error) {
    console.log("Error fetching key groups:", error);
    return NextResponse.json({ error: "Failed to fetch groups" }, { status: 500 });
  }
}

// POST /api/keys/groups - Create a group
export async function POST(request) {
  try {
    const body = await request.json();
    const checked = validateKeyGroupName(body?.name);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

    const group = await createApiKeyGroup(checked.value);
    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    if (error?.code === "API_KEY_GROUP_EXISTS") {
      return NextResponse.json({ error: "A group with this name already exists." }, { status: 409 });
    }
    console.log("Error creating key group:", error);
    return NextResponse.json({ error: "Failed to create group" }, { status: 500 });
  }
}
