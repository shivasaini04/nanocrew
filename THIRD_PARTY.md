# Third-party code and credits

NanoCrew is released under the MIT License (see `LICENSE`). It builds on, and includes code adapted from, the
projects below. Each keeps its own copyright and license.

Licenses listed here are the ones declared by the upstream project or in the file's own front matter. They have not
been independently audited. Open an issue if you spot a mistake.

## Upstream projects

| Project | Used for | License |
|---|---|---|
| [NanoClaw](https://github.com/qwibitai/nanoclaw) (Gavriel) | The orchestrator and group-chat runtime this repo was forked from | MIT (`LICENSE`) |
| nanobot contributors | The Python agent runtime in `container/nanoagent` | MIT (`container/nanoagent/LICENSE`) |
| [OpenClaw](https://github.com/openclaw/openclaw) | The skill format and metadata conventions | see upstream |

## Built-in skills (`container/nanoagent/nanoagent/skills`)

Each skill's `SKILL.md` front matter names its author and license. Summary of the sources:

| Source | Skills | Declared license |
|---|---|---|
| Hermes Agent / Nous Research / Teknium | general-purpose skills | MIT |
| Orchestra Research | the `mlops-*` and `research-*` skills (36) | MIT |
| [Anthropic financial-services](https://github.com/anthropics/financial-services) (adapted) | the `finance-*` modeling and authoring skills (7) | Apache-2.0 |
| [obra/superpowers](https://github.com/obra/superpowers) | planning, debugging and review skills | MIT |
| [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done) | workflow skills | MIT |
| [blader/humanizer](https://github.com/blader/humanizer) | `creative-humanizer` | MIT |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | `creative-hyperframes` | see upstream |
| Community contributors | integrations such as Notion, Airtable, Shopify, OpenHue | MIT |

Reference files inside some skills quote or mirror documentation from other projects (for example llama.cpp, unsloth,
Hugging Face). Those remain the property of their authors.

## Removed on purpose

- A PowerPoint skill that carried Anthropic's proprietary license.
- The patched Camoufox browser build (`engine-build`).

## Dependencies

Runtime dependencies are installed from npm and PyPI and keep their own licenses. See `package.json`,
`dashboard/package.json` and `container/nanoagent/pyproject.toml`.

### Dependencies with copyleft or unusual licenses

Checked 18 Oct 2026 with `license-checker` (npm) and `pip-licenses` (Python). Everything else is MIT, Apache-2.0, BSD,
ISC or similar.

| Dependency | License | Note |
|---|---|---|
| `@whiskeysockets/libsignal-node` | GPL-3.0 | Pulled in by Baileys (MIT), which powers the optional WhatsApp channel. Not copied into this repo; npm installs it. If GPL-3.0 does not suit your use, do not enable WhatsApp, or remove the Baileys dependency. |
| `sharp` (libvips binaries) | LGPL-3.0-or-later | Prebuilt image library, used as a normal dynamic dependency. |
| `python-telegram-bot` | LGPL-3.0 | Used as a library by the Telegram channel. |
| `lark-oapi` | MIT (licence file in the wheel; package metadata leaves the field blank) | Used by the optional Feishu channel. |
| `pymupdf` | AGPL-3.0 (or commercial) | Not a dependency of NanoCrew. The optional `productivity-ocr-and-documents` skill imports it if you install it yourself. |
