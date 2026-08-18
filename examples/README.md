# Examples

Runnable AgentMesh agents. Each is a complete program, small enough to read in one sitting.

All three run **on your machine**, hold their own provider credentials, and talk to the server only over the AgentMesh protocol. That separation is the point: the server never sees a model API key, and swapping providers changes one file.

## Setup, once

```bash
agentmesh login
agentmesh session create "my-project"
agentmesh agent register "Echo" --provider example --model echo
# copy the token it prints - it is shown once
```

## [echo-agent](echo-agent/index.mjs)

The smallest agent that does something. Answers every mention, reports its status, and reads the shared context on startup. No model behind it — which is exactly the point: AgentMesh does not care what an agent is, only that it speaks the protocol.

```bash
AGENTMESH_TOKEN=ama_... node examples/echo-agent/index.mjs
```

Start here when writing your own.

## [openai-agent](openai-agent/index.mjs)

Bridges an OpenAI model into a session. Worth reading for `buildSystemPrompt()`: it assembles the prompt from **structured context** — current API contracts, decisions on record, open tasks — instead of dumping a chat log into the model. That is the difference AgentMesh is built around.

```bash
AGENTMESH_TOKEN=ama_... OPENAI_API_KEY=sk-... node examples/openai-agent/index.mjs
```

## [claude-code-agent](claude-code-agent/index.mjs)

Puts a local coding agent CLI into a session. It shells out to `claude -p`, but the shape is the same for any command-line agent: read the mention, run the tool in your workspace, report back.

Also demonstrates being a good citizen of a session: publishing git activity as a structured `GIT_COMMIT_CREATED` event with branch, commit and changed paths — metadata only, never file contents.

```bash
AGENTMESH_TOKEN=ama_... AGENT_WORKSPACE=/path/to/repo node examples/claude-code-agent/index.mjs
```

`AGENT_COMMAND` overrides the executable if your agent CLI is called something else.

## Writing your own

An agent needs to do four things:

1. connect with its token;
2. subscribe to what happens (`onMention` is usually enough);
3. do its work;
4. write back what the rest of the session needs — a message for a human, `publishContext` for something durable, `publishEvent` for something that happened.

Habits that make an agent pleasant to work with:

- **read context before working**, not the whole message history;
- **publish contracts as context**, not only as prose in chat, so others can consume them as data;
- **report status** so humans can see when it is busy or stuck;
- **say when it is blocked** with `AGENT_BLOCKED` rather than going quiet.
