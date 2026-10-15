// Disposable loopback harness: the production heartbeat service, no model provider.
import { createServer } from "node:http";
import { sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../../../services/heartbeat.js";
const db = createDb(process.env.GITHUB_MONITOR_TEST_DB!);
const heartbeat = heartbeatService(db);
const server = createServer((_req, res) => res.end("test-only"));
server.listen(0, "127.0.0.1", () => process.send?.({ ready: true, pid: process.pid }));
process.on("message", async (message: { now: string }) => {
  try {
    const result = await heartbeat.tickTimers(new Date(message.now));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const active = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (!active.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    process.send?.({ result });
  }
  catch { process.send?.({ error: "tick failed" }); }
});
