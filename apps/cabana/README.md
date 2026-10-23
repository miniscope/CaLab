# CaBaNA

CaBaNA (Calcium Behavioral and Neural Analysis) relates neural activity to
behavioral states. It generalizes two earlier tools, CaMAP (place cells) and
CaSA (social behavior). The Python project lives at
[github.com/miniscope/CaBaNA](https://github.com/miniscope/CaBaNA).

## Status

Placeholder. This app was scaffolded from `apps/_template` so the landing page
can list CaBaNA as coming soon. The port has not started: foundational work
remains in the Python repo first. The UI is the template's generic import flow
and trace view, with no CaBaNA analysis behind it.

See [PLAN.md](./PLAN.md) for the proposed port. Nothing there is decided beyond
the placeholder.

```sh
npm run dev cabana
npm test -w apps/cabana
```

The `calab` block in `package.json` controls the landing-page card and the
`apps.json` manifest. See `docs/NEW_APP.md` at the repo root.
