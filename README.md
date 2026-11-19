# Recepees 🍳

A local recipe app: browse recipes, keep a stock, photograph ingredients with your phone, and generate recipes from what you have.

## Run
1. Install Node 18+ (no other install needed).
2. Optional, for AI features: `cp .env.example .env` and paste your `ANTHROPIC_API_KEY`.
3. `node server.js`
4. Open the **phone address** printed in the terminal on your phone (same Wi-Fi).

## Files
- `server.js` — zero-dependency server (stock/recipes JSON + Claude calls)
- `public/` — built React app
- `data/recipes.json`, `data/stock.json` — your data (edit freely)
- `src/` + `build.mjs` — source; rebuild with `npm install && node build.mjs`

Anyone on your Wi-Fi can open the page and use your API key, so run it on trusted networks only.
