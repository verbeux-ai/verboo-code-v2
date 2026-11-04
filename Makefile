# Short names for the Web and Desktop application commands. The package.json
# scripts they call stay the source of truth; docs/development.md documents both.
.DEFAULT_GOAL := help
.PHONY: help build clean web desktop dev-web dev-desktop

PNPM ?= pnpm
ARGS ?=

help:
	@echo "make build        pnpm run build           complete repository build"
	@echo "make clean        pnpm run clean           remove build outputs and safe deleted-package residue"
	@echo "make web          pnpm run start:web       serve the built Web artifacts from source"
	@echo "make desktop      pnpm run start:desktop   launch Tauri with built shared artifacts"
	@echo "make dev-web      pnpm run dev:web         build, serve, and rebuild Web on source edits"
	@echo "make dev-desktop  pnpm run dev:desktop     build, watch client and Rust, and launch Tauri"
	@echo "ARGS='--no-open --port 3081' forwards options to the launched application;"
	@echo "the Web commands accept dsh web flags, the Desktop launcher accepts Tauri development flags."

build:
	$(PNPM) run build

clean:
	$(PNPM) run clean

web:
	$(PNPM) run start:web $(ARGS)

desktop:
	$(PNPM) run start:desktop $(ARGS)

dev-web:
	$(PNPM) run dev:web $(ARGS)

dev-desktop:
	$(PNPM) run dev:desktop $(ARGS)
