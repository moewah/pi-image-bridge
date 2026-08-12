# Changelog

## 0.2.0 - 2025-08-12

### Breaking Changes

- Remove project-level config support (`.pi/pi-image-bridge.json`). The extension is now **global-only**, with a single config file at `~/.pi/agent/pi-image-bridge.json` shared across all projects
- `loadConfig()` no longer takes a `cwd` argument; the exported `deepMerge` helper is removed

### Refactor

- `/image-bridge`, `/image-bridge toggle` and `/image-bridge config` now operate exclusively on the global config

### Documentation

- README restructured: global-only positioning, corrected supported image formats (removed AVIF), reordered sections (Install before Configuration)
