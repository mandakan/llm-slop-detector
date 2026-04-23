# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.**

Use GitHub's [private vulnerability reporting](https://github.com/mandakan/llm-slop-detector/security/advisories/new) to send a private report. I will acknowledge receipt within a few days.

## Scope

This is a client-side VS Code extension. Realistic concerns:

- **Regex denial of service** in user-supplied or remote rule patterns (phrases). Currently rule patterns come from the bundled `builtin-rules.json`, a workspace-local `.llmsloprc.json`, or user settings. Remote rule lists are not implemented yet. If you find a pattern that can freeze the extension host, please report it.
- **Malicious rule files** that cause the extension to read or write outside the workspace.
- **Prompt injection through diagnostic messages** is not a realistic threat model for this extension; diagnostics are plain strings displayed by VS Code.

Out of scope: general VS Code vulnerabilities (report those to Microsoft), Node.js vulnerabilities (report those to Node), and concerns that depend on an attacker already having write access to your `.llmsloprc.json` or `settings.json`.
