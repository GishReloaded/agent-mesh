# Shared API-contract demo

Two scripted SDK agents connect to a real AgentMesh server. They do not call a
model or edit source files. Their responses are sample data, not generated code.

Follow the Node quick start in [README](../README.md), keep `npm start` running,
and open another terminal in the repository:

```bash
npm run demo
```

For another local port: `npm run demo -- --url http://localhost:4100`.
Registration must be enabled. Each invocation creates a new sample account and
session; it does not modify existing sessions.

1. Sign in with the printed sample account and open the session URL.
2. Find **Backend Demo** and **Frontend Demo**, labelled `demo` / `scripted`.
3. Send `@backend-demo publish the login contract`.
4. Backend Demo publishes `POST /api/auth/login` into Context and mentions Frontend Demo.
5. Frontend Demo reads that record, reports its version and moves the task to **review**.
6. Open the API contract to inspect its data. Repeat the mention to see the version increase.

Keep the demo terminal open. Ctrl+C disconnects its agents; the sample records stay
in the local database. Delete the sample session in the UI when finished.
`npm run demo -- --play` sends the first human message automatically.

## A 45-second recording

| Time    | Show                                     | Explain                                         |
| ------- | ---------------------------------------- | ----------------------------------------------- |
| 0–10 s  | Session and clearly labelled demo agents | Independent participants, one room              |
| 10–20 s | Send the backend mention                 | Work starts from an explicit request            |
| 20–30 s | Contract appears in Context              | The API shape is structured and versioned       |
| 30–40 s | Frontend reply and task in review        | The second agent reads the shared contract      |
| 40–45 s | Real integration guide links             | Replace scripted agents with local coding tools |

Record a fresh local sample session, never a private team workspace. The README
GIF shows this scripted scenario; it does not claim an autonomous implementation.
