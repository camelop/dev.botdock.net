import { Router, json, HttpError } from "../router.ts";
import {
  checkLatest,
  applyUpdate,
  getUpdateStatus,
} from "../../lib/self-update.ts";
import type { ForwardManager } from "../../domain/forward-manager.ts";

export function mountUpdate(router: Router, forwardManager: ForwardManager): void {
  router.get("/api/update/check", async () => {
    try {
      return json(await checkLatest());
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
  });

  router.get("/api/update/status", () => json(getUpdateStatus()));

  // Kick off an install. Returns 202 immediately; the frontend polls
  // /status for progress. On success this daemon execv's itself, the new
  // process comes up on the same port, and the frontend's instance_id
  // restart detection picks up the change and reloads.
  router.post("/api/update/install", async () => {
    const info = await checkLatest().catch((e) => {
      throw new HttpError(502, `check failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!info.newer_available) {
      throw new HttpError(409, `already at latest (${info.current})`);
    }
    // Fire-and-forget: the promise never resolves on success (we execv).
    // Errors update the shared status; catch here so nothing is unhandled.
    void applyUpdate(info, {
      stopForwards: () => forwardManager.stopAllAsync(3000),
    }).catch((err) => {
      // applyUpdate already wrote the error into status; nothing to do.
      console.error("[update] install failed:", err);
    });
    return json({ accepted: true, target: info.tag }, { status: 202 });
  });
}
