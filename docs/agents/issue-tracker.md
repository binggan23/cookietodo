# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone. The repo is `binggan23/cookietodo`.

## Pull requests as a triage surface

**PRs as a request surface: no.** This is a personal / solo repo; external PRs are not currently treated as a triage queue. `/triage` reads this flag and will skip the `gh pr` path accordingly.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `binggan23/cookietodo`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` (and `gh pr view <number>` if the number resolves to a PR).
