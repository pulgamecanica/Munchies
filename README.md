# Recepees 🍳

A Ghost site for **recipe tables** (ingredients down the left in order of use, each step a cell spanning exactly what it combines, all converging into the dish), plus a member **recipe box**: make tables with AI from a link, pasted text or cookbook photo, track kitchen stock, cook from what you have. AI use is metered per member and per plan.

```
browser ──► api (server.js, :3000) ──► /api/*  recipe box, stock, AI, usage, admin center
                                  └──► else    Ghost (theme, members, Portal, Stripe, /ghost admin)
```
Running everything on one origin means the Ghost member cookie reaches the API, which asks Ghost who is signed in. No extra auth system.

## Dev
```sh
cp .env.example .env      # set ports, ANTHROPIC_API_KEY, limits
bun run dev               # = docker compose up
```
- Site: `http://localhost:$PORT`, Ghost admin at `/ghost` (first visit creates the owner account)
- **Settings → Design → activate "recepees"** (one click, once)
- Sign-in emails land in mailpit at `http://localhost:$MAIL_UI_PORT`
- `theme/` is mounted live; `server.js` restarts on save
- `bun run check` validates the theme with gscan

## Publishing a recipe table
Write a normal Ghost post and add an **HTML card** containing:
```html
<script type="application/recipe+json">{"title":"…","servings":4,"steps":[{"text":"Whisk","after":[],"uses":[{"name":"flour","amount":250,"unit":"g"}]}]}</script>
```
`after` lists earlier steps whose result this step uses (defaults to the previous step). The **Copy for Ghost** button in the recipe box produces this snippet for you. Set post access to *Paid members* to make it Pro-only.

## Accounts and subscriptions
These are native Ghost. Signup and sign-in go through Portal. Plans live under **Settings → Membership → Tiers**, and **Connect Stripe** turns on paid plans. The API sees `free` vs `paid`/`comped` and applies `FREE_AI_PER_MONTH` / `PAID_AI_PER_MONTH`.

## API
| | |
|---|---|
| `GET /api/me` | member, plan, usage this month |
| `GET/PUT /api/stock` | kitchen stock |
| `GET/POST /api/recipes`, `DELETE /api/recipes/:id` | recipe box |
| `POST /api/convert` `{url|text|image}` | make a table (AI, metered) |
| `POST /api/generate` `{ingredients, notes}` | recipe from stock (AI, metered) |
| `POST /api/recognize` `{image}` | ingredients from a photo (AI, metered) |
| `/api/admin` | **admin center**: usage per member, reset usage (`ADMIN_TOKEN`) |
| `GET /api/health` | healthcheck |

Member data: `data/members/<uuid>.json`. New boxes start with `seed-recipes.json`.

## Deploy (GitHub → Coolify)
1. Push this repo to GitHub, then in Coolify add **Docker Compose** from the repo, file `docker-compose.prod.yml`.
2. Give the **api** service your domain (port 3000). Set env: `PUBLIC_URL`, `MYSQL_PASSWORD`, `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `SMTP_*`, `MAIL_FROM`.
3. Deploy. `Dockerfile.ghost` bakes the theme and `routes.yaml` into the Ghost image and re-copies both on every boot, so each redeploy ships theme changes. Activate the theme once in Ghost admin.
