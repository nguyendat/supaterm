import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

// default: offers a login URL, or runs with an auth key or a remembered sign-in.
// pending: control never answers, so sign-in offers no URL and logout gets no reply.
// crash-once: exits the first time it reaches Running, as a helper crash would.
// unknown-state: reports a backend state this server has never heard of while starting.
const mode = process.argv[2] ?? "default";
const self = {
  dnsName: "fake.tailnet.ts.net",
  ipv4: "100.64.0.1",
  ipv6: "fd7a:115c:a1e0::1",
  userId: "123456789012345678",
  loginName: "khoi@github",
  displayName: "Khoi",
  tagged: false,
  tags: [],
  keyExpiry: "2027-04-19T00:00:00Z",
};
let directory = "";
let serve = true;
let backendState = "NoState";
let logins = 0;
let renames = 0;

const send = (message, then) =>
  process.stdout.write(`${JSON.stringify({ v: 1, ...message })}\n`, then);
const marker = (name) => NodePath.join(directory, name);

const status = () => {
  const running = backendState === "Running";
  return {
    type: "status",
    backendState,
    ...(backendState === "NeedsLogin" && mode !== "pending"
      ? { authUrl: `https://login.tailscale.com/a/fake${logins}` }
      : {}),
    ...(running ? { self } : {}),
    https: running ? "ready" : "pending",
    listening:
      running && serve ? { https: `https://${self.dnsName}/`, http: `http://${self.ipv4}/` } : {},
    loggingRequired: false,
    health: [],
  };
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  switch (command.type) {
    case "configure": {
      directory = command.dir;
      serve = command.serve;
      send({ type: "hello", version: "fake", tailscaleVersion: "1.104.2" });
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.writeFileSync(marker("tailscaled.state"), "{}");
      NodeFS.writeFileSync(
        marker("launch.json"),
        JSON.stringify({
          environment: Object.keys(process.env),
          authKey: command.authKey ?? null,
          hostname: command.hostname,
          tags: command.tags,
          secretLength: command.ingress.secret.length,
        }),
      );
      backendState = mode === "unknown-state" ? "Upgrading" : "Starting";
      send(status());
      logins += 1;
      const authorized =
        mode !== "pending" &&
        (command.authKey !== undefined || NodeFS.existsSync(marker("authorized")));
      backendState = authorized ? "Running" : "NeedsLogin";
      if (!authorized) {
        send(status());
        break;
      }
      NodeFS.writeFileSync(marker("authorized"), "");
      if (mode === "crash-once" && !NodeFS.existsSync(marker("crashed"))) {
        NodeFS.writeFileSync(marker("crashed"), "");
        send(status(), () => process.exit(1));
        break;
      }
      send(status());
      break;
    }
    case "login":
      logins += 1;
      if (backendState === "NeedsLogin") send(status());
      break;
    case "setServe":
      serve = command.enabled;
      send(status());
      break;
    case "setHostname":
      renames += 1;
      if (command.hostname.startsWith("taken")) {
        send({
          type: "error",
          code: "set-hostname",
          message: `${command.hostname} is in use (rename ${renames})`,
          fatal: false,
        });
      } else {
        send(status());
      }
      break;
    case "logout":
      if (mode === "pending") break;
      send({ type: "loggedOut", confirmed: true }, () => process.exit(0));
      break;
    case "shutdown":
      process.exit(0);
  }
}
