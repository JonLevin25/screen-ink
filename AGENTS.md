# screen-ink

An Electron app (macOS first) that draws answers on top of the user's screen and speaks them. Main process in
`src/main`, overlay and windows in `src/renderer`, code shared by both in `src/shared`, the Swift screen helper in
`native/`, and the Claude Code plugin in `plugin/`.

## Commands

- `npm start`: build and run the app.
- `npm run preview`: open the overlay in a browser with a demo drawing.
- `npm run typecheck` and `npm run build`: both must pass (CI runs them).

## Conventions

- Commit messages are one line: `type(scope): imperative summary`.
- One change per pull request. Say how the change was checked in the running app.
- See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/GUIDE.md](docs/GUIDE.md) for setup and the file map.

@AGENTS.local.md
