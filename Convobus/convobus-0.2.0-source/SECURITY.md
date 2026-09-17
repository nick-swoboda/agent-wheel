# Security policy

## Supported version

Security fixes are currently made against the latest release of Convobus.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the
repository's GitHub **Security → Report a vulnerability** flow so the report and
any reproduction details remain private.

Include the affected version, macOS version, route/provider involved, impact,
and the smallest safe reproduction you can provide. Remove conversation text,
tokens, project paths, and other personal data before attaching logs.

Convobus stores local state under `.convobus`. Treat that directory as private
and do not attach it wholesale to an issue or report.
