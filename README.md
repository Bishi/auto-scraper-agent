# auto-scraper-agent

Windows tray application that runs the Auto-Scraper sidecar on a schedule and connects to the [auto-scraper](https://github.com/Bishi/auto-scraper) dashboard API. Build with `npm run build` (sidecar + Tauri).

**This repository** is open source under the MIT License. The **hosted dashboard / server** (`auto-scraper`) is a separate, **proprietary** codebase — only the agent is licensed here under MIT.

## Legal & privacy

- [LICENSE](LICENSE) — MIT
- [SECURITY.md](SECURITY.md) — vulnerability reporting and how secrets are handled
- [PRIVACY.md](PRIVACY.md) — local config and what leaves your machine

The full **End User License Agreement** text shown in the NSIS installer is in [`src-tauri/EULA.txt`](src-tauri/EULA.txt).

## Scraping disclaimer

You are solely responsible for lawful use and for complying with each target site’s terms of service. Do not bypass anti-bot measures or access controls. The software is provided “as is,” without warranty, for lawful monitoring only. See `EULA.txt` for the complete terms.
