# Security Policy

## Sensitive files

Do not commit real runtime configuration or user data. In particular, keep these local only:

- `config.yaml` and `config-*.yaml`
- `.env*`
- `data/`
- `gallery_images/`
- `logs/`
- `.claude/`
- private keys, tokens, API keys, database dumps, and uploaded media

Use `config.example.yaml` as the public template.

## Before publishing

Run a secret scan before pushing to a public repository, for example:

```bash
grep -RIn --exclude-dir=.git --exclude-dir=.venv --exclude-dir=data --exclude-dir=gallery_images --exclude-dir=logs \
  -E 'password|secret|token|api[_-]?key|Bearer|PRIVATE KEY' .
```

If a real secret was committed or pushed, remove it from history and rotate the secret immediately.

## Reporting vulnerabilities

Please report security issues privately to the repository maintainer. Do not disclose exploitable details publicly before a fix is available.
