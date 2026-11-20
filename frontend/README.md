# Frontend

Angular app for Chain. From the repository root:

```sh
docker compose up --build frontend
```

The dev server is at http://localhost:4200/. It opens on the login page (`/entrar`); a first admin is created as described in the root README and must change its password at first login (`/trocar-senha`). In development, `/_design` shows the design system. `/api` on that origin is proxied to the API.

From this directory:

```sh
npm test        # unit and component tests (Vitest)
npm run lint
npm run e2e     # Playwright against an isolated docker compose stack (needs Docker; once: npx playwright install chromium)
```

`npm run e2e` (`e2e/run.sh`) starts its own compose project, `chain-e2e`, on ports 54200, 58080 and 55432. The project has postgres, the API, the automation service, the frontend, and a stub target for automation steps (`e2e/compose.yml`, `e2e/stub/server.mjs`). The script bootstraps an admin with a random password, runs the tests in `e2e/tests/`, and removes the stack and its volume. It never touches the local `chain` stack or its data. Arguments after `--` go to Playwright, for example `npm run e2e -- --headed`.
