import { expect, it } from "vite-plus/test";
import { pushRequestHeaders } from "./pushRequest.ts";

it("matches the Go gateway's request-signing fixture", () => {
  expect(
    pushRequestHeaders(new Uint8Array(32).fill(1), "/v1/push/send", '{"version":1}', 1791840000),
  ).toEqual({
    "content-type": "application/json",
    "x-supacode-host": "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w",
    "x-supacode-timestamp": "1791840000",
    "x-supacode-signature":
      "BekRytzP30lJiPF4UOe3LmjrPeRd5DIeJ-9Dbzl3Gb_te_kUlV947XyRhleCf07oeYTuk96JupLiGggNKKElDw",
  });
});
