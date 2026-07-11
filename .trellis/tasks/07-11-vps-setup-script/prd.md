# One-shot VPS setup script

## Goal

Provide a single Ubuntu VPS setup script that prepares the host and builds
AcceptGPT from the current repository checkout.

## Requirements

- Add `deploy/vps-setup.sh` as a Bash script intended to be run from anywhere
  inside the checked-out project.
- Require root privileges, while allowing invocation either as root or through
  `sudo`.
- Support Ubuntu hosts using `apt-get`.
- Install Node.js 20 when a compatible Node.js version is not already present.
- Install Xvfb and the basic packages needed to download/install Node.js and
  Playwright Chromium.
- Ensure a persistent 2 GB swap file exists without replacing or shrinking
  existing swap capacity.
- Install locked Node dependencies, Playwright Chromium, and Chromium system
  dependencies.
- Build the TypeScript application with the repository's existing npm build
  script.
- Be safe to rerun: completed host setup should be detected or reused where
  practical.
- Stop immediately on failure and print clear progress messages.
- Do not create or overwrite `.env`, install reverse-proxy configuration, or
  enable/start the application systemd service.

## Acceptance Criteria

- [ ] `bash -n deploy/vps-setup.sh` succeeds.
- [ ] The script rejects non-root execution with a useful `sudo` hint.
- [ ] The script resolves the repository root relative to its own location, not
      the caller's current working directory.
- [ ] On a clean supported Ubuntu VPS, one invocation installs Node.js,
      Playwright Chromium, Xvfb, and creates up to 2 GB of swap before building
      the project successfully.
- [ ] Rerunning the script does not create duplicate swap entries or overwrite
      an existing `.env`.
- [ ] The final output explains that `.env` configuration and service startup
      are separate next steps.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
