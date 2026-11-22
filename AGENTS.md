# screen-ink

An Electron app (macOS first) that draws answers on top of the user's screen and speaks them. Main process in
`src/main`, overlay and windows in `src/renderer`, code shared by both in `src/shared`, the Swift screen helper in
`native/`, and the Claude Code plugin in `plugin/`.

## Commands

- `npm start`: build and run the app.
- `npm run preview`: open the overlay in a browser with a demo drawing.
- `npm run typecheck` and `npm run build`: both must pass (CI runs them).
- `npm run dev`: run the app with hot reload. Keep it running in the background while you work.

## Trying changes in the running app

- After a change, run `npm run reload`. By default it applies the change without losing what is on screen or
  disconnecting Claude Code sessions, and says what it did. If the app isn't running, start `npm run dev`.
- Exit code 3 means screen-ink is busy (answering, drawing, speaking, or the user has the ask bar open). Wait and run
  it again. Don't add `--force` to interrupt the user.
- Exit code 2 means the change can break the sessions connected to screen-ink or the user's saved settings. It lists
  why. Tell the user what would break and ask before running `npm run reload -- --force`.

## Conventions

- Commit messages are one line: `type(scope): imperative summary`.
- One change per pull request. Say how the change was checked in the running app.
- See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/GUIDE.md](docs/GUIDE.md) for setup and the file map.

@AGENTS.local.md
