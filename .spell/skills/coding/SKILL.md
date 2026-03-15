# Coding Skill

General coding guidance for this project. See AGENTS.md for the full development rules.

## Design Planning

When a task involves UI/frontend work:

- Use `/design` to enter design plan mode before writing any implementation code
- The `/design` command produces a **Design Direction Brief** with committed aesthetic direction, typography, color strategy, motion rules, spatial composition, and concrete token definitions adapted to codebase conventions
- The brief is the contract — the designer agent executes against it and does not re-decide aesthetic direction during implementation
- After implementation, a visual testing phase is mandatory: screenshots at key breakpoints and interaction states, compared against the brief. Done = looks right, not just builds.

Use `/ultraplan` for complex multi-file refactors. Use `/design` for anything visual.
