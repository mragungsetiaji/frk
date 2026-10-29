# Common tasks. `make help` lists them.

# Vite 8 needs Node >= 20.19. When nvm has a Node 22 installed, use it even if
# the shell's default is older; otherwise fall back to whatever `node` is.
NODE22 := $(lastword $(sort $(wildcard $(HOME)/.nvm/versions/node/v22.*/bin)))
ifneq ($(NODE22),)
export PATH := $(NODE22):$(PATH)
endif

PNPM := pnpm
BUNDLE_DIR := target/release/bundle
REPO ?=

.PHONY: help install dev browser test lint check app dmg install-app clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

install: ## Install frontend dependencies
	$(PNPM) install

dev: ## Run the app in development (REPO=path opens a repository on launch)
	$(PNPM) tauri dev $(if $(REPO),-- -- $(REPO))

browser: ## Run the UI in a browser against public/dev-fixture.json
	$(PNPM) dev

test: ## Rust tests and the TypeScript type check
	cargo test -p frk-core
	$(PNPM) exec tsc --noEmit

lint: ## rustfmt and clippy
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings

check: lint test ## Everything CI would run

app: ## Release build of frk.app
	$(PNPM) tauri build --bundles app
	@echo "\n  $(BUNDLE_DIR)/macos/frk.app"

# CI=true skips the Finder AppleScript that lays out the .dmg window: Finder
# can keep the temporary image busy and fail the build, and the layout is
# cosmetic (the Applications link is still added).
dmg: ## Release build packaged as a .dmg installer
	CI=true $(PNPM) tauri build --bundles dmg
	@echo "\n  $$(ls -t $(BUNDLE_DIR)/dmg/*.dmg | head -1)"

install-app: app ## Build and copy frk.app into /Applications
	rm -rf /Applications/frk.app
	cp -R $(BUNDLE_DIR)/macos/frk.app /Applications/
	@echo "Installed /Applications/frk.app"

clean: ## Remove build output
	cargo clean
	rm -rf dist
