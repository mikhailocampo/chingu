/**
 * The shared miniflare/workerd process is disposed here. Named `zz-` so bun's
 * alphabetical file order runs it last.
 *
 * Do NOT call shutdown() from a per-file afterAll: the instance is shared
 * across suites, so the first file to finish would dispose it out from under
 * whichever file is still running. That surfaces as a MiniflareCoreError on an
 * unrelated test, which is a confusing way to learn this.
 * Same reason backend/workers/tools/test does it this way.
 */
import { test } from "bun:test";
import { shutdown } from "./harness";

test("shutdown shared workerd", async () => {
  await shutdown();
});
