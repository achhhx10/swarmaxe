# Upgrading upstream

The `dist` patches are tied to a version. After **any** upgrade of
`opencode-swarm-plugin`:

```bash
~/.config/opencode/patches/patch-swarm-plugin.py
~/.config/opencode/patches/patch-swarm-indexer.py
~/.config/opencode/patches/swarmaxe-doctor.sh
```

If the doctor reports a missing marker, the upgrade replaced the patched files.
If it reports a compile failure, the bundle changed shape: check
`docs/TROUBLESHOOTING.md` before deploying.

## Version pin

`install.sh` pins `0.63.2` because:

- `embedSingle` must call `/api/embed` with `options.num_ctx`
- the connection open path must not replay `auto_vacuum`/`TRUNCATE`
- `SessionIndexer.indexFile` must consult `index-state.json`

A different version may still work, but the patch scripts assert their anchors
and will fail loudly rather than silently produce a half-patched bundle.

## Rolling back upstream

```bash
npm install -g opencode-swarm-plugin@0.63.2
```

The `.pre-patch` and `.pre-indexpatch` backups next to `dist/bin/swarm.js` are
the pristine files.
