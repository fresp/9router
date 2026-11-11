import { NextResponse } from "next/server";
import { deleteApiKeyGroup, getApiKeyGroupById, setApiKeyGroupAccess, setApiKeyGroupActive } from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// PUT /api/keys/groups/[id] - Bulk-update every key in the group:
// `isActive` enables or pauses them, `access` overwrites their access settings.
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access } = body || {};
    if (isActive === undefined && access === undefined) {
      return NextResponse.json({ error: "isActive or access is required" }, { status: 400 });
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    let checkedAccess = null;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      checkedAccess = checked.value;
    }
    if (!(await getApiKeyGroupById(id))) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    let updated = 0;
    if (checkedAccess) updated = await setApiKeyGroupAccess(id, checkedAccess);
    if (isActive !== undefined) updated = await setApiKeyGroupActive(id, isActive);
    return NextResponse.json(checkedAccess ? { updated, access: checkedAccess } : { updated });
  } catch (error) {
    console.log("Error updating key group:", error);
    return NextResponse.json({ error: "Failed to update group" }, { status: 500 });
  }
}

// DELETE /api/keys/groups/[id] - Delete a group; its keys become ungrouped
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteApiKeyGroup(id);
    if (!deleted) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Group deleted successfully" });
  } catch (error) {
    console.log("Error deleting key group:", error);
    return NextResponse.json({ error: "Failed to delete group" }, { status: 500 });
  }
}
