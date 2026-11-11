import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getApiKeys, getApiKeyGroups } from "@/lib/localDb";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, apiKeyId, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const apiKeyId = searchParams.get("apiKeyId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (apiKeyId) filter.apiKeyId = apiKeyId;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);

    // Redact conversation payloads: the stored details include full request
    // bodies (user prompts, tool calls) and provider responses. Returning them
    // wholesale lets any dashboard-authenticated user (or, if requireLogin is
    // disabled, anyone) read every user's conversation history. Keep the
    // metadata (model, tokens, latency, status) but drop message content.
    // Caller key: name and group as they are now; the stored name snapshot
    // covers a key deleted since. Only id/name/group leave the server.
    const [keys, groups] = await Promise.all([
      getApiKeys().catch(() => []),
      getApiKeyGroups().catch(() => []),
    ]);
    const keyById = new Map(keys.map((k) => [k.id, k]));
    const groupNameById = new Map(groups.map((g) => [g.id, g.name]));
    const describeCaller = (d) => {
      if (d.apiKeyId) {
        const key = keyById.get(d.apiKeyId);
        return {
          id: d.apiKeyId,
          name: key?.name || d.apiKeyName || "Deleted key",
          group: key ? groupNameById.get(key.groupId) || null : null,
          deleted: !key,
        };
      }
      if (d.apiKeyMasked) return { id: null, name: d.apiKeyMasked, group: null, unknown: true };
      return null;
    };

    const redactedDetails = (result.details || []).map((d) => {
      const { apiKeyId: _id, apiKeyName: _name, apiKeyMasked: _masked, ...rest } = d;
      const redacted = { ...rest, apiKey: describeCaller(d) };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      return redacted;
    });

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
