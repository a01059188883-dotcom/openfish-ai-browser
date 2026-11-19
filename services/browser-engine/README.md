# OpenFish Self-hosted Browser Engine

A free/open-source Playwright + Chromium service intended to replace Cloudflare Browser Run when deployed on compute you control. It exposes the browser operation shapes used by OpenFish: `/status`, `/view`, `/navigate`, `/action`, `/tabs`, and `/close`.

## Run with Docker

Generate a long random token (at least 32 characters), then:

```sh
docker build -t openfish-browser-engine services/browser-engine
docker run -d --name openfish-browser-engine --restart unless-stopped \
  -p 127.0.0.1:8788:8788 \
  -e OPENFISH_ENGINE_TOKEN='REPLACE_WITH_A_LONG_RANDOM_SECRET' \
  openfish-browser-engine
```

Keep this service behind a TLS reverse proxy or private network. Do not expose port 8788 directly to the public internet. Use a separate token from the OpenFish Relay token.

## API

All browser routes require both `Authorization: Bearer <OPENFISH_ENGINE_TOKEN>` and a client-generated `X-OpenFish-Session` ID (8–80 URL-safe characters). `/health` requires only the bearer token so container health probes do not create browser sessions.

- `GET /health`
- `GET /status`
- `GET /view`
- `POST /navigate` with `{"url":"https://example.com"}`
- `POST /action` with the existing OpenFish action payload
- `POST /close`

The service maintains a separate browser context per validated X-OpenFish-Session ID, with multiple pages (tabs) inside that session. Session contexts expire after 30 minutes of inactivity by default (configurable with OPENFISH_ENGINE_SESSION_TTL_MS); a lightweight unref'ed timer checks for idle sessions at least every 60 seconds, and active sessions are capped by OPENFISH_ENGINE_MAX_SESSIONS. A busy session cannot be closed mid-operation; retry after the current action finishes. `GET /tabs` lists the open tabs; `/action` supports `newTab`, `switchTab` and `closeTab` in addition to navigation and page interaction. Restarting the container or calling `/close` ends that session. It includes URL validation and DNS resolution checks to block private/reserved network destinations. Keep outbound network controls enabled at the host level too.

## Hosting options and realistic limits

The browser software is free, but a browser server needs CPU, RAM, storage, and network. No public cloud provider guarantees unlimited free compute. Oracle Cloud Always Free currently advertises up to 2 Ampere OCPUs and 12 GB RAM equivalent, but capacity and account/region restrictions apply; it may be unavailable in a chosen home region. See https://www.oracle.com/cloud/free/ and https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm.

Free Render and Koyeb instances are not suitable as a permanent always-on browser: they sleep or scale to zero and have low memory/CPU. See https://render.com/docs/free and https://www.koyeb.com/docs/reference/instances.

Browserless's self-hosted Docker image is another option, but its repository uses SSPL-1.0 or a commercial license; review that before using it in a proprietary commercial deployment. This service uses Playwright directly instead.

## Security notes

- Use HTTPS and a strong, private engine token.
- Put the service behind an authenticated reverse proxy or private network.
- Restrict egress at the server/firewall level. Application-level URL checks are defense in depth, not a replacement for network isolation.
- Do not use this engine to bypass CAPTCHAs, authentication, paywalls, or site restrictions.
- Session contexts are isolated from one another in memory, but the shared bearer token is a service credential, not end-user identity. Do not expose it to untrusted clients or treat this as a complete multi-tenant identity system.

## Network request policy and tab lifecycle (engine 1.3.4)

The engine validates the initial navigation URL and installs a browser-context request guard. The guard revalidates HTTP(S) destinations for page requests, subresources, and redirect hops; service workers are disabled so they cannot bypass the context route. Browser WebSocket connections are blocked. Private, loopback, link-local, metadata, multicast, and special-purpose IPv4/IPv6 ranges are rejected.

This is defense in depth, not a complete sandbox. DNS validation and Chromium's later DNS lookup are separate operations, so DNS rebinding remains a time-of-check/time-of-use risk. For public hosting, enforce outbound firewall/egress rules that deny private, loopback, link-local, metadata, and reserved destinations at the network layer. Do not expose this service without TLS and a strong bearer token.

Tab indexes are scoped to the active in-memory browser context and may change when a tab closes. The cloud relay serializes browser actions per session; it does not yet provide durable per-tab profiles or multi-tenant isolation.
