# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

- Ignore unresolved MCPB/DXT config placeholders (`${user_config.X}`) in credentials. A blank optional Kaseya One token field caused Claude Desktop to inject the literal `${user_config.kaseya_vsa_k1_token}` string, which was preferred over valid local username/password and made every request authenticate with a bogus SSO token (401). Empty, whitespace-only, and placeholder credential values are now normalised to "absent" at ingress for both env and gateway-header sources (mirrors itglue-mcp #73).

### Added
- **Interactive device card via MCP Apps (SEP-1865).** `kaseya_vsa_get_agent` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension) instead of a wall of JSON. The card shows the endpoint's name, online/offline status, computer name, organization, machine group, operating system, IP address, and last check-in — all label-resolved server-side from the VSA agent record. The card is read-only (no write actions). Non-App hosts are unaffected: the tool's JSON payload is the raw agent plus a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://kaseya-vsa/device-card.html` resource served as `text/html;profile=mcp-app`. The server now declares the `resources` capability and answers `resources/list` / `resources/read` for the card.
  - The card is **neutral by default** and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` environment variables (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`), applied at serve time by replacing the card's `BRAND_INJECT` marker. No branding configured = the HTML is served unchanged and the card renders with no brand identity.
  - The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/device-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and fs-less runtimes.
  - The card payload builder is best-effort: a sparse or unrecognized agent degrades the card (or drops it) without affecting the tool result. New contract tests in `test/mcp-apps.test.ts` drive the real server over an in-memory transport to pin the `_meta` advertisement, the `ui://` resource wire shape, and the `_card` normalization.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/` (requires the new `vite`, `vite-plugin-singlefile`, and `@modelcontextprotocol/ext-apps` devDependencies); plain `npm run build` and CI are unaffected.
- Initial scaffold of the Kaseya VSA MCP server.
- Stdio + HTTP (StreamableHTTP) transports.
- Gateway-mode credential handling via `X-Kaseya-VSA-Tenant-Url`, `X-Kaseya-VSA-Username`, `X-Kaseya-VSA-Password`, and `X-Kaseya-VSA-K1-Token` headers.
- 12 tools covering endpoints, software/hardware inventory, patches, agent procedures, alarms, tickets, organizations, and machine groups.
- Destructive actions (`kaseya_vsa_deploy_patches_now`, `kaseya_vsa_run_procedure`) gated behind elicitation confirmations.
- Multi-stage `Dockerfile` with GitHub Packages auth via build secret.
- Semantic-release based CI release pipeline (`.github/workflows/release.yml`).
- MCPB packaging script and Smithery registry config.
