import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE push_registrations ADD COLUMN preview_key_json TEXT`;
  yield* sql`ALTER TABLE push_notifications ADD COLUMN preview_json TEXT`;
  yield* sql`ALTER TABLE push_deliveries ADD COLUMN payload_json TEXT`;
});
