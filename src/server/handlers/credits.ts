import { Router, json, parseJsonBody, HttpError } from "../router.ts";
import { DataDir } from "../../storage/index.ts";
import {
  creditAccountExists,
  deleteCreditAccount,
  listCreditAccounts,
  readCreditAccount,
  readCreditAccountCredential,
  writeCreditAccount,
  type CreditAccount,
} from "../../domain/credit-accounts.ts";
import { refreshCreditAccount } from "../../domain/credit-refresher.ts";

type AccountInput = Partial<CreditAccount> & { credential?: string };

export function mountCredits(router: Router, dir: DataDir): void {
  router.get("/api/credits", () => json(listCreditAccounts(dir)));

  router.get("/api/credits/:nickname", ({ params }) => {
    if (!creditAccountExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    return json(readCreditAccount(dir, params.nickname!));
  });

  router.get("/api/credits/:nickname/credential", ({ params }) => {
    if (!creditAccountExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    return json({ credential: readCreditAccountCredential(dir, params.nickname!) });
  });

  router.post("/api/credits", async ({ req }) => {
    const body = await parseJsonBody<AccountInput>(req);
    if (!body.nickname) throw new HttpError(400, "nickname required");
    if (!body.provider) throw new HttpError(400, "provider required");
    if (creditAccountExists(dir, body.nickname)) throw new HttpError(409, "already exists");
    const acc: CreditAccount = {
      nickname: body.nickname,
      provider: body.provider,
      description: body.description ?? "",
      added_at: new Date().toISOString(),
      last_checked_at: body.last_checked_at,
      balance: body.balance,
      limit: body.limit,
      unit: body.unit,
      period: body.period,
      notes: body.notes,
    };
    writeCreditAccount(dir, acc, body.credential);
    return json(acc, { status: 201 });
  });

  router.put("/api/credits/:nickname", async ({ req, params }) => {
    if (!creditAccountExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    const body = await parseJsonBody<AccountInput>(req);
    const cur = readCreditAccount(dir, params.nickname!);
    const merged: CreditAccount = {
      ...cur,
      // caller may freely overwrite any field except the identifier
      provider: body.provider ?? cur.provider,
      description: body.description ?? cur.description,
      last_checked_at: body.last_checked_at ?? cur.last_checked_at,
      balance: body.balance !== undefined ? body.balance : cur.balance,
      used: body.used !== undefined ? body.used : cur.used,
      limit: body.limit !== undefined ? body.limit : cur.limit,
      unit: body.unit ?? cur.unit,
      period: body.period ?? cur.period,
      notes: body.notes ?? cur.notes,
    };
    writeCreditAccount(dir, merged, body.credential);
    return json(merged);
  });

  router.post("/api/credits/:nickname/refresh", async ({ params }) => {
    if (!creditAccountExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    try {
      const updated = await refreshCreditAccount(dir, params.nickname!);
      return json(updated);
    } catch (err) {
      // The refresher already persisted the error onto the account; surface
      // the message to the caller so the UI can toast it.
      throw new HttpError(502, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete("/api/credits/:nickname", ({ params }) => {
    if (!creditAccountExists(dir, params.nickname!)) throw new HttpError(404, "not found");
    deleteCreditAccount(dir, params.nickname!);
    return json({ ok: true });
  });
}
