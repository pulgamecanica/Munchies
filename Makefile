# Recepees. `make` lists targets. Settings come from .env (Docker Compose reads it too).
-include .env
PORT ?= 3000
MAIL_UI_PORT ?= 8026
URL := http://localhost:$(strip $(PORT))
PROD := docker compose -f docker-compose.build.yml # local production stack, built from this checkout

# Release: bump VERSION (and RELEASE_NAME), commit and push to main. CI releases any version that isn't released yet:
# GitHub builds GHCR images + a Release, Forgejo makes a source-zip Release. `make release` does the bump-commit-tag-push for you.
VERSION := 1.1.1
RELEASE_NAME := Second Breakfast

.DEFAULT_GOAL := help
.PHONY: help env dev up down restart logs ps check zip ocr-test build prod prod-down prod-logs reset version release-name print-version release ci

help: ## Show this list
	@grep -hE '^[a-z-]+:.*## ' Makefile | awk -F':.*## ' '{printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example (keeps an existing one)
	@test -f .env && echo ".env already exists" || (cp .env.example .env && echo "created .env, add your ANTHROPIC_API_KEY")

dev: env ## Run the dev stack in the foreground
	docker compose up --build

up: env ## Run the dev stack in the background and print the URLs
	docker compose up -d --build
	@printf "site   $(URL)\nadmin  $(URL)/ghost\nusage  $(URL)/api/admin\nmail   http://localhost:$(strip $(MAIL_UI_PORT))\n"

down: ## Stop the dev stack (data is kept)
	docker compose down

restart: ## Restart the gateway + Ghost (e.g. after changing package.json or routes.yaml)
	docker compose restart api ghost

logs: ## Follow logs (make logs s=ghost for one service)
	docker compose logs -f $(s)

ps: ## Show running services
	docker compose ps

check: ## Validate the theme with gscan (Ghost's theme checker)
	npx -y gscan theme

zip: ## Build recepees-theme.zip to upload in Ghost admin
	rm -f recepees-theme.zip && cd theme && zip -qr ../recepees-theme.zip . -x '.*' && echo "recepees-theme.zip ready"

ocr-test: ## OCR an image through the running stack: make ocr-test img=page.jpg
	@test -n "$(img)" || (echo "usage: make ocr-test img=path/to/photo.jpg" && exit 1)
	@docker compose exec -T ocr node -e "process.stdin.pipe(require('http').request('http://127.0.0.1:8884/',{method:'POST'},(r)=>r.pipe(process.stdout)))" < "$(img)"; echo

build: ## Build the production images from source (ghost with theme, gateway, ocr)
	$(PROD) build

prod: ## Run the production stack locally, built from source (needs PUBLIC_URL, MYSQL_PASSWORD, ADMIN_TOKEN in .env)
	$(PROD) up -d --build

prod-down: ## Stop the local production stack
	$(PROD) down

prod-logs: ## Follow production logs
	$(PROD) logs -f $(s)

reset: ## DELETE all dev data (Ghost content + member DB) and start fresh
	@read -p "Delete the dev Ghost volume and data/? [y/N] " a && [ "$$a" = y ]
	docker compose down -v
	rm -rf data

version: ## Show the version and release name
	@echo "v$(VERSION): $(RELEASE_NAME)"

release-name:
	@echo "$(RELEASE_NAME)"

print-version:
	@echo "$(VERSION)"

ci: ## Run the CI checks locally (JS syntax, gscan, API smoke test)
	sh .ci/check.sh

release: ## Sync versions, commit, tag v$(VERSION), push to every remote (CI releases it)
	@test -z "$$(git status --porcelain)" || (echo "Commit or stash your changes first." && exit 1)
	@! git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null || (echo "v$(VERSION) already exists: bump VERSION in the Makefile." && exit 1)
	@node -e 'const fs=require("fs");for(const f of ["package.json","theme/package.json"]){const p=JSON.parse(fs.readFileSync(f));p.version="$(VERSION)";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")}'
	@git diff --quiet || git commit -qam "Release v$(VERSION): $(RELEASE_NAME)"
	git tag -a "v$(VERSION)" -m "$(RELEASE_NAME)"
	@for r in $$(git remote); do echo "→ $$r"; git push -q "$$r" HEAD && git push -q "$$r" "v$(VERSION)"; done
	@echo "Released v$(VERSION): $(RELEASE_NAME). Watch the Actions tab on GitHub and Forgejo."

