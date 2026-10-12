# Supacode

The next version of supacode, a command center for ur coding agents

## Desktop app

Download at https://next.supacode.sh

## iOS app

[Join the Supacode beta on TestFlight](https://testflight.apple.com/join/ga2vGT3h).

## Command line

```
curl -fsSL https://next.supacode.sh/install.sh | sh
```

on Windows

```
irm https://next.supacode.sh/install.ps1 | iex
```

Then run `supacode` to start the server and open the local web app. `supacode service install` keeps it running in the background, `supacode update` moves to a newer release

To try it once without installing, run npx supacode@latest instead.

## Documentation

The [documentation index](./docs/README.md) for all pages.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [Background service](./docs/user/background-service.md)

## License

MIT, except [`apps/relay`](./apps/relay), which is AGPL-3.0-only.

## Attribution

Supacode is a fork of https://github.com/pingdotgg/t3code
