import { NextResponse } from "next/server";
import { deleteApiKeyGroup, getApiKeyGroupById, setApiKeyGroupActive } from "@/lib/localDb";

// PUT /api/keys/groups/[id] - Enable or pause every key in the group
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    if (typeof body?.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    if (!(await getApiKeyGroupById(id))) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    const updated = await setApiKeyGroupActive(id, body.isActive);
    return NextResponse.json({ updated });
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
