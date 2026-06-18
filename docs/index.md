---
layout: home
title: Home
nav_order: 1
---

# Cheasee-Pi

{: .fs-9 }

Autonomous coding agent operating within the Pi Stack. Built on the pi-coding-agent harness, extended with custom skills, tools, and workflows.

{: .fs-6 .fw-300 }

[Get started](#getting-started){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/SchneiderDaniel/cheasee-pi){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## Overview

Cheasee-Pi is an extension stack built on top of **pi**, the AI coding agent. It provides:

- **Custom extensions** — Modular tools and features extending pi's capabilities
- **Skills** — Reusable instruction sets for specialized tasks (dead code hunting, bug hunting, extension spec design)
- **Custom workflows** — GitHub Actions and automation pipelines
- **Flask blogs** — Blog management integration

## Getting started

1. **Clone** the repository:
   ```bash
   git clone git@github.com:SchneiderDaniel/cheasee-pi.git
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run** the agent with pi:
   ```bash
   pi
   ```

## Project structure

```
.
├── .pi/                 # Pi configuration, skills, settings
├── custom/              # Custom extensions
├── flask_blogs/         # Blog management
├── scripts/             # Utility scripts
├── docs/                # Documentation (this site)
├── benchmarks/          # Performance benchmarks
└── test/                # Tests
```

## Documentation

| Section | Description |
|---------|-------------|
| [Architecture](/cheasee-pi/architecture/) | System design and component overview |
| [Extensions](/cheasee-pi/extensions/) | Available extensions and how to create new ones |
| [Skills](/cheasee-pi/skills/) | Pre-built skill definitions |
| [Workflows](/cheasee-pi/workflows/) | CI/CD and automation guides |
| [Reference](/cheasee-pi/reference/) | API docs, config reference |
