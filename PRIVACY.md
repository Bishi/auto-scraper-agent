# Privacy (desktop agent)

This repository is the **desktop agent** for [auto-scraper](https://github.com/Bishi/auto-scraper). It runs locally on Windows or macOS and talks to your configured server over HTTPS.

## What stays on your machine

- **Configuration** is stored under `~/.auto-scraper/agent.json` (server URL, agent ID, agent secret, and optional legacy API key). It is not embedded in the installer binary.
- **No database** is shipped with the agent; listing and scrape data live on the server you connect to.
- **Telemetry:** none is sent by this agent beyond what you configure (heartbeats and scrape traffic to your own server URL).

## What goes to the server

Pairing requests, scrapes, and heartbeats are sent only to the configured **server URL**. If no URL is saved yet, the packaged app defaults to `https://auto-scraper-develop.up.railway.app`. Legacy API-key registration is sent only when you explicitly use the legacy setup form. That service's privacy practices are described in the server repo's [PRIVACY.md](https://github.com/Bishi/auto-scraper/blob/main/PRIVACY.md).

## Contact

For questions about this desktop app, use the same channels as the main project (see server `SECURITY.md` / maintainer contact).
