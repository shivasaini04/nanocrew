# Changelog

## 0.1.0 (26 Oct 2026)

First public release. Multi-agent orchestrator, React dashboard, sandboxed Python agent runtime, LiteLLM model
gateway, approvals, scheduling, memory and about 200 built-in skills.

Release preparation includes:

- Owner-scoped crew graphs, pipeline references and triggers, notifications, and operator tool management.
- Updated dependency locks for the orchestrator, dashboard and optional channel components; removed unused image
  and link-preview peers. The orchestrator's Playwright browser install matches its pinned package version.
- Localhost-only Compose ports, complete secret setup instructions and a working public clone URL.
- Linux CI, Docker quickstart and full-history secret scanning with narrowly documented test-fixture exceptions.

Known limitations: the first agent image build is large (allow at least 20 GB free), Windows maintainer tests have
platform-specific failures, and this early release may introduce breaking changes.
