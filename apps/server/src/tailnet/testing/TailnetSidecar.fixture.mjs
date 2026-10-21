import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const mode = process.argv[2] ?? "default";
const self = {
  dnsName: "fake.tailnet.ts.net",
  ipv4: "100.64.0.1",
  ipv6: "fd7a:115c:a1e0::1",
  userId: "123456789012345678",
  loginName: "khoi@github",
  displayName: "Khoi",
  tagged: false,
  tags: null,
  keyExpiry: "2027-04-19T00:00:00Z",
};
let serve = true;
let backendState = "NoState";
let logins = 0;

const send = (message, then) =>
  process.stdout.write(`${JSON.stringify({ v: 1, ...message })}\n`, then);

const status = () => {
  if (backendState === "Running") {
    return {
      type: "status",
      backendState,
      self,
      https: "ready",
      listening: serve ? { https: `https://${self.dnsName}/`, http: `http://${self.ipv4}/` } : {},
      loggingRequired: false,
      health: null,
    };
  }
  return {
    type: "status",
    backendState,
    ...(backendState === "NeedsLogin"
      ? { authUrl: `https://login.tailscale.com/a/fake${logins}` }
      : {}),
    https: "pending",
    loggingRequired: false,
    health: null,
  };
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  switch (command.type) {
    case "configure": {
      serve = command.serve;
      send({ type: "hello", version: "fake", tailscaleVersion: "1.104.2" });
      NodeFS.mkdirSync(command.dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(command.dir, "tailscaled.state"), "{}");
      NodeFS.writeFileSync(
        NodePath.join(command.dir, "launch.json"),
        JSON.stringify({
          environment: Object.keys(process.env),
          authKey: command.authKey ?? null,
          hostname: command.hostname,
          tags: command.tags,
          secretLength: command.ingress.secret.length,
        }),
      );
      if (mode === "silent") break;
      backendState = "Starting";
      send(status());
      logins += 1;
      backendState = command.authKey === undefined ? "NeedsLogin" : "Running";
      if (mode === "crash" && backendState === "Running") {
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
      send(status());
      break;
    case "logout":
      send({ type: "loggedOut", confirmed: true }, () => process.exit(0));
      break;
    case "shutdown":
      process.exit(0);
  }
}
