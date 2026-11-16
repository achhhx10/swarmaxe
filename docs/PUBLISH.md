# Publish on GitHub

`gh` is not required.

1. Create an **empty** repository named `swarmaxe` (no README, no licence).
2. From this folder:

```bash
git config user.name  "achhhx10"
git config user.email "120988631+achhhx10@users.noreply.github.com"
git remote add origin git@github.com:achhhx10/swarmaxe.git
git branch -M main
git push -u origin main
```

3. Repository settings: licence MIT, topics
   `opencode`, `swarm`, `multi-agent`, `sqlite`, `mcp`, `developer-tools`.
4. Optional CI: run `./verify.sh` — it checks coverage, the Skill Forge,
   TypeScript syntax (`node --check`), Python and bash syntax. No network needed.

Before pushing, confirm nothing private slipped in:

```bash
git ls-files | grep -Ei "\.db|\.env|auth\.json|service\.json|\.log$" || echo clean
grep -rnE "sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}" . || echo clean
```
