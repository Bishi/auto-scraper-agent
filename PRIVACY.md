# Privacy (desktop agent)

This repository is the **Windows desktop agent** for [auto-scraper](https://github.com/Bishi/auto-scraper). It runs locally and talks to your configured server over HTTPS.

## What stays on your machine

- **Configuration** is stored under `%USERPROFILE%\.auto-scraper\agent.json` (server URL and API key). It is not embedded in the installer binary.
- **No database** is shipped with the agent; listing and scrape data live on the server you connect to.
- **Telemetry:** none is sent by this agent beyond what you configure (heartbeats and scrape traffic to your own server URL).

## What goes to the server

The API key and requests (scrapes, heartbeats) are sent only to the **server URL you enter**. That service’s privacy practices are described in the server repo’s [PRIVACY.md](https://github.com/Bishi/auto-scraper/blob/main/PRIVACY.md).

## Contact

For questions about this desktop app, use the same channels as the main project (see server `SECURITY.md` / maintainer contact).
