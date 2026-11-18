# OpenFish Self-hosted Browser Engine

A free/open-source Playwright + Chromium service intended to replace Cloudflare Browser Run when deployed on compute you control. It exposes the same browser operation shapes used by OpenFish: `/status`, `/view`, `/navigate`, `/action`, and `/close`.

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

All routes require `Authorization: Bearer <OPENFISH_ENGINE_TOKEN>`.

- `GET /health`
- `GET /status`
- `GET /view`
- `POST /navigate` with `{"url":"https://example.com"}`
- `POST /action` with the existing OpenFish action payload
- `POST /close`

The service keeps one browser page in memory. Restarting the container or calling `/close` ends that session. It includes URL validation and DNS resolution checks to block private/reserved network destinations. Keep outbound network controls enabled at the host level too.

## Hosting options and realistic limits

The browser software is free, but a browser server needs CPU, RAM, storage, and network. No public cloud provider guarantees unlimited free compute. Oracle Cloud Always Free currently advertises up to 2 Ampere OCPUs and 12 GB RAM equivalent, but capacity and account/region restrictions apply; it may be unavailable in a chosen home region. See https://www.oracle.com/cloud/free/ and https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm.

Free Render and Koyeb instances are not suitable as a permanent always-on browser: they sleep or scale to zero and have low memory/CPU. See https://render.com/docs/free and https://www.koyeb.com/docs/reference/instances.

Browserless's self-hosted Docker image is another option, but its repository uses SSPL-1.0 or a commercial license; review that before using it in a proprietary commercial deployment. This service uses Playwright directly instead.

## Security notes

- Use HTTPS and a strong, private engine token.
- Put the service behind an authenticated reverse proxy or private network.
- Restrict egress at the server/firewall level. Application-level URL checks are defense in depth, not a replacement for network isolation.
- Do not use this engine to bypass CAPTCHAs, authentication, paywalls, or site restrictions.
- The default service is a single-user/single-page engine, not a multi-tenant SaaS.
