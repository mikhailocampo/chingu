import type { Env } from "./types";
import { speak, NO_BOOKING, NOT_AUTHORISED, NO_SUCH_TOOL } from "./speak";
import { isAuthorised } from "./auth";
import { resolveSlot } from "./slots";
import { getBrief } from "./brief";
import { confirmChoice } from "./confirm-choice";
import { confirmVenue } from "./confirm-venue";
import { escalate } from "./escalate";

/**
 * VocalBridge tool endpoints. Called by the voice agent mid-call.
 *
 * Correlation lives in the URL path (/tools/:slot/*), never in arguments:
 * VB sends no per-call context, and the model corrupts any identifier it is
 * asked to carry (0-for-4 on an employee id, 0-for-3 on a year). The slot is
 * resolved to a dispatch server-side; the LLM never handles an identifier.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, root, slot, tool] = url.pathname.split("/");

    if (root !== "tools" || !slot || !tool) {
      // Even a routing miss must be speakable — it may reach the agent.
      return speak(NO_SUCH_TOOL, { error: "not_found" }, 404);
    }

    try {
      return await route(request, env, slot, tool);
    } catch (err) {
      // Never let an exception reach the agent as a 500: a crash mid-call is
      // worse than a graceful exit.
      console.error("tools_worker_error", { slot, tool, err: String(err) });
      return speak(NO_BOOKING, { options: [] });
    }
  },
};

async function route(
  request: Request,
  env: Env,
  slot: string,
  tool: string,
): Promise<Response> {
  // Auth first, before any lookup: otherwise an unauthenticated caller learns
  // which slots are live from the difference between 200 and 401.
  if (!isAuthorised(request, env, slot)) {
    return speak(NOT_AUTHORISED, {}, 401);
  }

  const bound = await resolveSlot(env, slot);

  if (request.method === "GET" && tool === "get_brief") {
    return getBrief(env, bound);
  }
  if (request.method === "POST" && tool === "confirm_choice") {
    return confirmChoice(env, bound, await readParams(request));
  }
  if (request.method === "POST" && tool === "confirm_venue") {
    return confirmVenue(env, bound, await readParams(request));
  }
  if (request.method === "POST" && tool === "escalate") {
    return escalate(env, bound, await readParams(request));
  }

  return speak(NO_SUCH_TOOL, { error: "not_found" }, 404);
}

/**
 * Read tool arguments from wherever VB happens to put them.
 *
 * `parameters[].location` is an undocumented enum and only `"query"` has ever
 * been verified live, so a tool configured the verified way sends its arguments
 * in the query string rather than a JSON body. Accepting both — plus
 * form-encoding — costs nothing and removes an integration failure that would
 * be silent: the endpoint would return 200 and do nothing.
 *
 * A body value wins over a query value of the same name; nothing here is
 * trusted anyway, every value is validated downstream against D1.
 *
 * VB also sends `Content-Length: 0` when the model tries to pass an undeclared
 * argument, so an empty or malformed body is a normal case, not an error.
 */
async function readParams(request: Request): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of new URL(request.url).searchParams) params[k] = v;

  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(params, parsed);
      }
    } else if (
      type.includes("application/x-www-form-urlencoded") ||
      type.includes("multipart/form-data")
    ) {
      for (const [k, v] of await request.formData()) params[k] = v;
    } else {
      // No usable content-type. Try JSON anyway — VB has not been observed
      // omitting it, but a bare body must not be dropped on the floor.
      const text = (await request.text()).trim();
      if (text.startsWith("{")) Object.assign(params, JSON.parse(text));
    }
  } catch {
    // Unparseable body: fall back to whatever the query string gave us.
  }
  return params;
}
