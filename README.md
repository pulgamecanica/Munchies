# Recepees 🍳

A Ghost site for **recipe tables**: ingredients run down the left in the order they're used, each step is a cell spanning exactly what it combines, and everything converges into the dish. Members also get a **recipe box**. They can turn a link, pasted text or a cookbook photo into a table, track their kitchen stock, and cook from what they have. AI use is metered per member and per plan.

No npm dependencies anywhere: everything runs on Node 24 built-ins, plain browser JS, Ghost and Tesseract.

```
browser ──► api (server.js :3000) ──► /api/*  recipe box, stock, OCR, AI, usage, admin center ──► SQLite (data/recepees.db)
                                 │                                    └──► ocr (Tesseract :8884, internal only)
                                 └──► else    Ghost (theme, members, Portal, Stripe, /ghost admin)
```
Everything is served from one origin, so the Ghost member cookie reaches the API, which asks Ghost who is signed in (cached for 30s). There's no second auth system.

| Service | What | Image |
|---|---|---|
| `api` | gateway + API, the only public port | `Dockerfile` (node:24-alpine) |
| `ghost` | site, members, subscriptions, admin | `Dockerfile.ghost` in prod (theme baked in), `ghost:6-alpine` + mounted theme in dev |
| `ocr` | Tesseract 5 over HTTP | `ocr/Dockerfile` |
| `db` | MySQL 8.4, prod only (dev uses sqlite) | `mysql:8.4` |
| `mailpit` | catches sign-in emails, dev only | `axllent/mailpit` |

## Quick start (dev)
```sh
make env        # creates .env: set ANTHROPIC_API_KEY, ports, limits
make up         # builds + starts, prints the URLs
```
- Site: `http://localhost:$PORT`. Ghost admin is at `/ghost`; your first visit creates the owner account.
- **Settings → Design → activate "recepees"** (one click, once).
- Sign-in links land in mailpit at `http://localhost:$MAIL_UI_PORT`.
- `theme/` is mounted live and `server.js` restarts on save. Run `make restart` after editing `ghost/routes.yaml`.

Run `make` on its own to list every target:

| | |
|---|---|
| `make dev` / `make up` / `make down` | run in foreground / background / stop |
| `make logs [s=ghost]` | follow logs |
| `make check` | validate the theme with gscan |
| `make zip` | `recepees-theme.zip` for uploading to any Ghost site |
| `make ocr-test img=page.jpg` | OCR an image through the running stack |
| `make build` / `make prod` | build / run the production stack locally |
| `make reset` | **delete** all dev data and start fresh (asks first) |

`bun run dev` still works; it calls `make dev`.

## Settings (`.env`)
Docker Compose reads `.env` for both stacks. In Coolify, set the same names as environment variables.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (empty) | turns on the AI features |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | |
| `FREE_AI_PER_MONTH` / `PAID_AI_PER_MONTH` | `5` / `200` | AI uses per member per month |
| `API_RATE_PER_MIN` | `120` | per-IP limit on `/api/*` |
| `ADMIN_TOKEN` | `dev` | unlocks `/api/admin`. **Use a long random value in prod.** |
| `OCR_LANGS` | `eng+fra` | Tesseract languages (installed: eng fra deu spa ita por nld; add more in `ocr/Dockerfile`) |
| `PORT` / `MAIL_UI_PORT` | `3000` / `8026` | dev host ports |
| `GHOST_VERSION` | `6` | dev Ghost image tag |
| `PUBLIC_URL` | (empty) | prod: `https://your.domain` |
| `MYSQL_PASSWORD` | (empty) | prod |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | mailpit in dev | prod needs real SMTP for member sign-in |

## Languages
The UI is fully translated into **English, Español, Français, Português, Italiano and Deutsch**. Each visitor gets their own choice from the picker in the header. If they haven't picked one, it uses their browser language, then the site's publication language (Ghost → Settings → General), then English.

- **UI text** lives in `theme/assets/js/i18n.js`. The keys are the English text, so anything missing falls back to English. In templates, add `data-t` to an element; in JS, call `t('Text', { vars })`.
- **AI output follows the visitor's language.** New tables, generated recipes and recognised stock come back in it.
- **Translate → \<language\>** appears on any recipe written in a different language (metered as one AI use). Posts count as the site language unless the recipe JSON has `"lang": "fr"` (or another code).
- **To add a language:** add it to `LANGS` and `D` in `i18n.js` and to `LANG_NAMES` in `server.js`.
- **Ghost's own pieces** (the Portal signup popup and member emails) follow the site's publication language, because Ghost sets those per site, not per visitor.

## Publishing a recipe table
Write a normal Ghost post and add an **HTML card** containing:
```html
<script type="application/recipe+json">{"title":"…","servings":4,"steps":[{"text":"Whisk","after":[],"uses":[{"name":"flour","amount":250,"unit":"g"}]}]}</script>
```
`after` lists the earlier steps whose result this step uses (it defaults to the previous step). Steps with nothing to combine, like "preheat oven", appear above the table. The **Copy for Ghost** button in the recipe box produces this snippet for you. Set post access to *Paid members* to make a recipe Pro-only.

## Accounts and subscriptions
These are native Ghost features: Portal handles signup and sign-in. Plans live under **Settings → Membership → Tiers**, and **Connect Stripe** turns on paid plans. The API treats `free` as free and `paid`/`comped` as paid, then applies the monthly limits.

## OCR
Cookbook photos are OCR'd first. If the page has enough text (80+ characters), Claude gets that text instead of the image, which costs less and is usually more accurate on dense pages. Otherwise it falls back to Claude vision. **Just read the text (free)** in the recipe box runs OCR alone, doesn't count against the AI limit, and drops the result into the *Paste text* tab for editing. The OCR service has no public port and runs as many jobs at once as there are CPU cores (`OCR_CONCURRENCY`).

## API
| | |
|---|---|
| `GET /api/me` | member, plan, usage this month |
| `GET/PUT /api/stock` | kitchen stock |
| `GET/POST /api/recipes`, `DELETE /api/recipes/:id` | recipe box |
| `POST /api/ocr` `{image}` | text from a photo (free) |
| `POST /api/convert` `{url\|text\|image}` | make a table (AI, metered) |
| `POST /api/generate` `{ingredients, notes}` | recipe from stock (AI, metered) |
| `POST /api/recognize` `{image}` | ingredients from a photo (AI, metered) |
| `POST /api/translate` `{recipe, lang}` | translate a recipe (AI, metered) |
| `/api/admin` | **admin center**: usage per member, reset usage (Bearer `ADMIN_TOKEN`) |
| `GET /api/health` | healthcheck |

Images are sent as `data:image/...;base64,` URLs. The AI endpoints take an optional `lang` (`en es fr pt it de`). Every endpoint except health and admin requires a signed-in member.

## Security
- **Usage limits:** taking one AI use is a single SQL statement, so parallel requests can't go over the limit. A failed AI call gives the use back.
- **Rate limiting:** per IP on `/api/*`. The IP is the hop added by your own proxy (Traefik), so clients can't spoof it.
- **Pasted links:** only public http(s) addresses, re-checked on every redirect, with 15s timeouts.
- **Headers:** `nosniff`, `SAMEORIGIN` and a referrer policy on everything; HSTS behind https; a strict CSP on API and admin responses. Ghost pages don't get a CSP, because Portal and Stripe load third-party scripts.
- **Text on pages** is escaped, and recipe source links only allow http(s).
- **Containers:** the OCR service and Ghost are internal only. The api and ocr containers run as non-root.

## Deploy (GitHub → Coolify)
1. Push this repo to GitHub. In Coolify, add a **Docker Compose** resource from the repo using `docker-compose.prod.yml`.
2. Give the **api** service your domain (port 3000). Set `PUBLIC_URL`, `MYSQL_PASSWORD`, `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `SMTP_*` and `MAIL_FROM`.
3. Deploy, then activate the theme once in Ghost admin. `Dockerfile.ghost` bakes the theme and `routes.yaml` into the Ghost image and re-copies them on every boot, so each redeploy ships theme changes.

Data lives in the `api-data` (SQLite), `ghost-content` and `db` volumes. Back those up.
