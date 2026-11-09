# Security policy

## Supported versions

Only the latest published release is supported. Sqraft is at `0.0.x`,
so security fixes ship as a new patch release rather than as backports.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private reporting instead:

1. Open <https://github.com/wfdx165/sqraft/security/advisories/new>
2. Describe the issue, the version (About panel), and the steps to
   reproduce

If private reporting is unavailable, contact the maintainer through the
GitHub profile <https://github.com/wfdx165> and ask for a private channel.

Expect an acknowledgement within a few days. There is no bug bounty.

## Scope and known boundaries

These are documented design decisions, not vulnerabilities:

- **The MCP endpoint has no token.** It binds to `127.0.0.1` only and
  rejects requests carrying an `Origin` header, but any process on the
  same machine can connect while the app is running. Do not run Sqraft on
  a shared or untrusted machine.
- **The build is unsigned and not notarized.** macOS Gatekeeper will block
  the first launch until you allow it. The updater verifies HTTPS hosts
  and the SHA-256 of the downloaded zip, but the package itself carries no
  code signature.
- **There is no telemetry and no crash reporting.** Logs stay on disk
  (`~/Library/Logs/Sqraft/`).

Reports about the boundaries above are welcome as documentation
improvements, but they are not treated as security fixes.
