/**
 * The shared miniflare/workerd process is disposed here. Named `zz-` so bun's
 * alphabetical file order runs it last.
 */
import { test } from "bun:test";
import { shutdown } from "./harness";
test("shutdown shared workerd", async () => { await shutdown(); });
