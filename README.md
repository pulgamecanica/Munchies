# Recepees 🍳

Recipes you can actually cook from. Ingredients run down the left in the order you use them, each step spans exactly what it combines, and everything converges into the dish. Built as a **Ghost** theme with a small companion API: members get **My kitchen** (collections, stock, today's pick), and the AI turns any link, pasted text or cookbook photo into a recipe, metered per plan.

No npm dependencies anywhere: Node 24 built-ins, plain browser JS, Ghost and Tesseract.

<!-- SCREENSHOTS: drop PNGs into docs/screenshots/ with these names (see docs/screenshots/README.md). -->
| | |
|---|---|
| **Library** | **A recipe** |
| ![Library](docs/screenshots/home.png) | ![A recipe](docs/screenshots/recipe.png) |
| | |
| **My kitchen**: today's pick, create a recipe | **Collections** as 3D stacks |
| ![My kitchen](docs/screenshots/kitchen.png) | ![Collections as 3D stacks](docs/screenshots/collections.png) |
| **Ingredient explorer** | **Print** in every style |
| | |
| ![Ingredient explorer](docs/screenshots/explorer.png) | ![Print styles](docs/screenshots/print.png) |
| **Colour themes**: Enamel, Pastel, Summer, Night | **Admin center** |
| | |
| ![Colour themes](docs/screenshots/themes.png) | ![Admin center](docs/screenshots/admin.png) |
| **On a phone** | **How to read a recipe**: the animated explainer |
| ![On a phone](docs/screenshots/phone.png) | ![How to read a recipe](docs/screenshots/how-to-read.png) |

## Features
**For members**
- **Recipes as convergence tables**: scale servings, tick off steps, see what's missing from your stock, translate, print.
- **Create a recipe** from a link, pasted text or a cookbook photo (OCR first, AI vision as fallback). **Extract text only** is free.
- **Live stock checks:** a faint red dot marks ingredients you need to buy, an amber one those you have too little of (weights and volumes are converted); the notice is in a tooltip. Amounts in recipes and stock have a pencil on hover to type a number. Adding stock (explorer, photo, by hand) updates open recipes immediately, and names are matched ignoring case, spaces and symbols, so no duplicates.
- **Timers:** the clock next to Print opens a timer for every step with a time in it ("Bake 60 min", "1 h 20 min", in 6 languages). Four looks (countdown, clock, grid, a tree that grows as time passes), optional badges inside the table and an optional black-out cover that melts away as time runs down. When a timer ends the whole screen turns into an alarm with sound and vibration until you press Done. Timers survive reloads. One recipe cooks at a time: starting a timer or ticking a step on another recipe asks first (listing what's still going) and resets the old one, so its timers never go off later. While a recipe is in progress, a "Cooking now" mini window (picture-in-picture) follows you on every other page with its progress and live timers, and opens the recipe again in one click (kitchen recipes via `/my/?open=<id>`).
- **Today's pick**: one recipe a day from your stock, free; claim a copy into your kitchen.
- **Collections**: three pre-filled starters plus the built-in **All**; 3D stacks you can flip through, or grid / list layouts; covers, hiding, ordering; an overview to manage them all.
- **Stock**: add by photo, by hand, or tap tiles in the **ingredient explorer**; shelves by category with icons; **Sort my stock with AI** (limited per plan).
- **Trash**: deleted collections, recipes and ingredients are restorable (`/my/trash/`, linked at the bottom of the kitchen); every delete has Undo.
- **How to read a recipe** (`/how-to-read/`): an animated, captioned, narrated line-art explainer with a full player. Storyboard and art direction: [`docs/how-to-read/STORYBOARD.md`](docs/how-to-read/STORYBOARD.md).
- **6 languages** (English, Español, Français, Português, Italiano, Deutsch) and **4 colour themes** (Enamel, Pastel, Summer, Night), both remembered per visitor and per member.

**For the site owner**
- Accounts, plans and payments are **native Ghost** (Portal + Stripe).
- **Admin center** (`/api/admin`): analytics, per-member usage editing and bonus AI uses, stock tags with SVG icons, AI tagging mode.
- **AI models you control**: any number of providers (Anthropic, or anything OpenAI-compatible: OpenAI, OpenRouter, Gemini, Groq, Mistral, self-hosted Ollama) and models, in a fallback order. Each request uses the first model that is on, not rate-limited and under its budget; failures fall through to the next. Budgets in dollars per day, week or month, per model and in total; free models have no limit and make a good last resort.
- **Ghost design settings**: kitchen name and default colour theme.

## How it fits together
```
browser ──► api (server.js :3000) ──► /api/*  kitchen, stock, OCR, AI, usage, admin center ──► SQLite (data/recepees.db)
                                 │                                    └──► ocr (Tesseract :8884, internal only)
                                 └──► else    Ghost (theme, members, Portal, Stripe, /ghost admin)
```
One origin for everything, so the Ghost member cookie reaches the API, which asks Ghost who is signed in (cached for 30s). There's no second login system.

| Service | What | Image |
|---|---|---|
| `api` | gateway + API, the only public port | `Dockerfile` (node:24-alpine) |
| `ghost` | site, members, subscriptions, admin | `Dockerfile.ghost` in prod (theme baked in), `ghost:6-alpine` + mounted theme in dev |
| `ocr` | Tesseract 5 over HTTP | `ocr/Dockerfile` |
| `db` | MySQL 8.4, prod only (dev uses sqlite) | `mysql:8.4` |
| `mailpit` | catches sign-in emails, dev only | `axllent/mailpit` |

| Path | |
|---|---|
| `server.js` | gateway + API |
| `admin.html` | admin center |
| `theme/` | the Ghost theme (`*.hbs`, `assets/css/screen.css`, `assets/js/*.js`) |
| `ghost/routes.yaml` | `/my/` (kitchen) and `/my/trash/` |
| `theme/page-how-to-read.hbs`, `theme/assets/how-to-read/`, `theme/partials/how-to-read-art.hbs` | the explainer page: template, storyboard + voice-over, line art |
| `ocr/` | OCR microservice |
| `default-tags.json`, `seed-recipes.json` | built-in stock tags and starter recipes |

## Develop
```sh
make env        # creates .env: set ANTHROPIC_API_KEY, ports, limits
make up         # builds + starts, prints the URLs
```
- Site: `http://localhost:$PORT`. Ghost admin is at `/ghost`; your first visit creates the owner account.
- **Settings → Design → activate "recepees"** (once).
- Sign-in emails land in mailpit at `http://localhost:$MAIL_UI_PORT`.
- `theme/` is mounted live (no asset caching in dev) and `server.js` restarts on save. Run `make restart` after editing `ghost/routes.yaml` or `theme/package.json`.

| | |
|---|---|
| `make dev` / `make up` / `make down` | run in foreground / background / stop |
| `make logs [s=ghost]` | follow logs |
| `make check` | validate the theme with gscan |
| `make zip` | `recepees-theme.zip` for uploading to any Ghost site |
| `make ocr-test img=page.jpg` | OCR an image through the running stack |
| `make build` / `make prod` | build / run the production stack locally |
| `make reset` | **delete** all dev data and start fresh (asks first) |

`bun run dev` also works; it calls `make dev`.

## Settings
Docker Compose reads `.env` for both stacks; in Coolify set the same names as environment variables.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_URL` | (empty) | optional: each one that is set adds that AI provider, tied to its variable (the key is read from the env, never stored). Or add providers in the admin center instead. |
| `<NAME>_MODELS` (e.g. `OPENROUTER_MODELS`) | (empty) | models to add to the end of the fallback chain, comma-separated: `model` or `model@IN/OUT` (USD per 1M tokens; `@0/0` = free). A new `ANTHROPIC_API_KEY` without `ANTHROPIC_MODELS` adds `CLAUDE_MODEL` (default `claude-sonnet-5-5`). Unknown prices are added switched off. Only ever adds; the admin center owns the list. |
| `AI_MODEL_BUDGET` | `50` | monthly dollar budget given to each paid model added from the env |
| `AI_BUDGET` / `AI_BUDGET_PERIOD` | (none) / `month` | total cap for all paid models, used until you set one in the admin center |
| `<NAME>_BASE_URL` | the provider's API | override a provider's address (e.g. `ANTHROPIC_BASE_URL` for a proxy) |
| `FREE_AI_PER_MONTH` / `PAID_AI_PER_MONTH` | `5` / `200` | AI uses per member per month |
| `SORT_FREE_PER_MONTH` / `SORT_PAID_PER_MONTH` | `3` / `30` | AI stock sorts per month (also count toward the allowance) |
| `API_RATE_PER_MIN` | `120` | per-IP limit on `/api/*` |
| `ADMIN_TOKEN` | `dev` | unlocks `/api/admin`. **Use a long random value in production.** |
| `SECRET_KEY` | (empty; dev stack: a fixed dev value) | encrypts the AI provider API keys you save in the admin center (AES-256-GCM); without it, keys can't be saved there. Generate with `openssl rand -hex 32`. If it is lost or changed, re-enter the keys. |
| `OCR_LANGS` | `eng+fra` | Tesseract languages (installed: eng fra deu spa ita por nld; add more in `ocr/Dockerfile`) |
| `PORT` / `MAIL_UI_PORT` | `3000` / `8026` | dev host ports |
| `GHOST_VERSION` | `6` | dev Ghost image tag |
| `PUBLIC_URL` | (empty) | production: `https://your.domain` |
| `MYSQL_PASSWORD` | (empty) | production |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | mailpit in dev | production needs real SMTP for member sign-in |

**In Ghost admin → Settings → Design:** *Kitchen name* (default "My kitchen", translated; a custom name shows as typed) and *Palette* (the default colour theme).
**In the admin center:** stock tags + icons, AI tagging mode (off / assign / assign and create), member usage and bonus AI uses.

## Publishing a recipe
Write a normal Ghost post and add an **HTML card** containing:
```html
<script type="application/recipe+json">{"title":"…","servings":4,"steps":[{"text":"Whisk","after":[],"uses":[{"name":"flour","amount":250,"unit":"g"}]}]}</script>
```
`after` lists the earlier steps whose result this step uses (defaults to the previous step); steps with nothing to combine, like "preheat oven", appear above the table. Staff signed in to Ghost get a **Copy for Ghost** button on any recipe in their kitchen that produces this snippet. Set post access to *Paid members* for Pro-only recipes; add `"lang": "fr"` (etc.) if a recipe isn't in the site's language.

## Languages
- **UI text** lives in `theme/assets/js/i18n.js`; keys are the English text, so anything missing falls back to English. In templates add `data-t` to an element; in JS call `t('Text', { vars })`.
- **AI output follows the visitor's language**; **Translate → \<language\>** converts any recipe (one AI use).
- **To add a language:** add it to `LANGS` and `D` in `i18n.js`, `LANG_NAMES` in `server.js`, and a name column in `theme/assets/js/ingredients.js`.
- Ghost's own Portal popup and member emails follow the site's publication language (Ghost → Settings → General).

## API
| | |
|---|---|
| `GET /api/me`, `PUT /api/prefs` | member, plan, usage, preferences (colour theme) |
| `GET/PUT /api/stock` | stock (items removed by a PUT go to the trash) |
| `POST /api/stock/sort` | AI files untagged stock under tags (metered, per-plan cap) |
| `GET /api/ingredients/history` | every ingredient the member's kitchen has seen |
| `GET /api/tags` | stock tags + the AI tagging mode |
| `GET/POST /api/recipes`, `DELETE /api/recipes/:id` | the member's recipes |
| `GET/POST /api/collections`, `PATCH/DELETE /api/collections/:id` | collections (`all` is built in) |
| `GET /api/daily`, `POST /api/daily/claim` | today's pick, claim a copy |
| `GET/DELETE /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash/:id` | trash |
| `POST /api/ocr` `{image}` | text from a photo (free) |
| `POST /api/convert` `{url\|text\|image}` | create a recipe (AI, metered) |
| `POST /api/generate` `{ingredients, notes}` | recipe from stock (AI, metered) |
| `POST /api/recognize` `{image}` | ingredients from a photo (AI, metered) |
| `POST /api/translate` `{recipe, lang}` | translate a recipe (AI, metered) |
| `/api/admin`, `/api/admin/*` | admin center + its API (Bearer `ADMIN_TOKEN`) |
| `GET /api/health` | healthcheck |

Images are sent as `data:image/...;base64,` URLs. AI endpoints take an optional `lang` (`en es fr pt it de`). Everything except health and admin needs a signed-in member.

## Security
- **Usage limits** are single SQL statements, so parallel requests can't overshoot; a failed AI call gives the use back.
- **Rate limiting** per IP on `/api/*`, using the hop your own proxy (Traefik) adds, so clients can't spoof it.
- **Pasted links:** public http(s) only, re-checked on every redirect, 15s timeouts.
- **Headers:** `nosniff`, `SAMEORIGIN`, referrer policy everywhere; HSTS behind https; strict CSP on API and admin responses (Ghost pages skip it because Portal and Stripe load third-party scripts).
- **SVG icons** render as CSS masks (they can't run code), and the server rejects scripts, event handlers and links in them.
- **Containers:** OCR and Ghost are internal only; api and ocr run as non-root.

## CI/CD and releases
- **On every push / PR:** `.ci/check.sh` (JS syntax, gscan, API smoke test) on GitHub and Forgejo; GitHub also validates the compose files and builds all 3 images. Run the same checks locally with `make ci`.
- **Releasing:** bump `VERSION` (and `RELEASE_NAME`) at the top of the `Makefile` and push to `main`. On every push, CI checks whether that version is released yet; if not, it releases it (pushing a `v*` tag works too, and an existing release is never redone). `make release` does the version sync, commit, tag and push in one go.
  - **GitHub** builds `linux/amd64` + `linux/arm64` images to GHCR (`ghcr.io/<owner>/<repo>-{api,ghost,ocr}`, tagged with the version and `latest`) and publishes a Release with notes and `recepees-theme.zip`.
  - **Forgejo** publishes a Release with the source code as a zip. It uses the job token; if your instance restricts it, add a `RELEASE_TOKEN` secret. The runner label is `docker` (edit `.forgejo/workflows/*.yml` if yours differs).
- **Images:** every release publishes `ghcr.io/pulgamecanica/munchies-{api,ghost,ocr}` (`latest` and the version number), which `docker-compose.prod.yml` pulls.

## Deploy (Coolify)
There are two compose files for production:

| File | Needs the source code? | Use it when |
|---|---|---|
| **`docker-compose.prod.yml`** | **No.** Pulls the released images from GHCR. | Deploying anywhere, including pasting it into Coolify. **Recommended.** |
| `docker-compose.build.yml` | Yes: its `build:` paths point into this repo. | Coolify builds from your Git repo, or `make prod` locally. |

**Recommended: prebuilt images**
1. **Release first.** Push `main` with a new `VERSION` in the `Makefile` (see *CI/CD and releases*). Wait for the GitHub *Release* run to finish: the images then exist on GHCR.
2. **Make the images pullable.** GitHub → your profile → *Packages* → `munchies-api`, `munchies-ghost`, `munchies-ocr` → *Package settings* → *Change visibility* → **Public** (once per package). Or keep them private and add GHCR credentials in Coolify (*Keys & Tokens → Docker Registry*: `ghcr.io`, your GitHub username, a token with `read:packages`).
3. **Coolify → New resource → Docker Compose Empty**, paste `docker-compose.prod.yml`. (Or *Public/Private Git Repository → Docker Compose* with the compose path `/docker-compose.prod.yml`: Coolify reads the file from the repo but still pulls the images.)
4. **Domain:** on the **api** service set your domain, e.g. `https://recipes.example.com` (container port 3000). No other service needs a domain.
5. **Environment variables:**

   | Variable | Value |
   |---|---|
   | `PUBLIC_URL` | the same domain, with `https://` |
   | `MYSQL_PASSWORD` | a long random password (also used for the MySQL user) |
   | `ADMIN_TOKEN` | a long random string (unlocks `/api/admin`) |
   | `SECRET_KEY` | `openssl rand -hex 32`: encrypts AI provider keys saved in the admin center. Keep a copy; if it changes, re-enter the keys |
   | `ANTHROPIC_API_KEY` (and/or `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_URL`, each with optional `<NAME>_MODELS`) | optional: AI providers from the env; or add them in `/api/admin`, where you also order models and set budgets |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | needed so members can sign in (magic links) |
   | `RECEPEES_VERSION` | optional: pin a release, e.g. `1.0.0` (default `latest`) |
6. **Deploy.** Open `https://your.domain/ghost` and create the owner account, then **Settings → Design → activate "recepees"** (once). Create a **page** with the slug `how-to-read` for the explainer. Connect Stripe under **Settings → Membership** for paid plans. Turn on comments under **Settings → Membership → Commenting** (all members or paid only); the theme shows them under every post.
7. **Updates:** release a new version, then *Redeploy* in Coolify (with `latest`) or change `RECEPEES_VERSION`.

**Alternative: build on the server.** In Coolify choose *Git Repository → Docker Compose* and set the compose path to `/docker-compose.build.yml`. Coolify clones the repo, so the `build:` paths resolve. Same domain and variables as above. Builds are slower, but no GHCR access is needed.

**Data** lives in the `api-data` (SQLite: kitchens, usage, tags), `ghost-content` (images, theme, settings) and `db` (MySQL: members, posts) volumes. Back those up. Each boot re-copies the theme and `routes.yaml` from the Ghost image, so updating the image updates the theme.
