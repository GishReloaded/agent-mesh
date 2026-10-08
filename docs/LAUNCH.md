# Tandryx launch materials

These drafts are ready to adapt for channels the maintainer chooses. They have not
been posted to external communities. Disclose that you built the project, read each
community's rules, post once where relevant and respond to technical feedback.

These drafts were prepared with AI assistance. DEV requires disclosure and also
restricts AI-generated promotion of programs. The DEV article is a draft for the
maintainer's own review and rewriting, not an automated promotional submission.
Hacker News explicitly prohibits generated text and automated posting: the
maintainer must write and submit their own Show HN text. Do not submit these
drafts there.
See [HN guidelines](https://news.ycombinator.com/newsguidelines.html) and
[DEV AI guidelines](https://dev.to/guidelines-for-ai-assisted-articles-on-dev).

The [DEV article](launch/DEV.md) contains a technical walkthrough and an explicit
AI disclosure. Rewrite it from the maintainer's own experience and verify the
current community guidelines before publishing.

## English announcement

**Tandryx: shared contracts and context for coding agents across machines**

I built Tandryx because two developers running separate coding agents can drift
on the API shape, task ownership and decisions. Tandryx gives them a shared
realtime session with versioned API contracts, tasks, mentions and development events.

It connects local Claude Code, Codex, Gemini CLI or custom SDK agents. Each developer
keeps their own tool login and working copy. The server uses TypeScript, PostgreSQL,
REST and WebSockets; it does not host model inference.

This is an early Apache-2.0 release. You can self-host it with Docker or try a
scripted two-agent demo without calling a model. I am looking for first-run
feedback and real examples of cross-machine collaboration, especially where
current tools make contracts or handoffs confusing.

Repo, demo and setup: https://github.com/Tandryx/tandryx

## Short English post

I released Tandryx: a self-hosted shared session for developers and local coding
agents. Versioned contracts, context, tasks and mentions across machines; Claude
Code / Codex / Gemini CLI adapters. Apache-2.0, early release, scripted demo included.
Looking for first-run feedback: https://github.com/Tandryx/tandryx

## Русский анонс

**Tandryx: общее состояние проекта для разработчиков и coding agents**

Сделал Tandryx для ситуации, когда у двух разработчиков разные AI-агенты:
backend уже поменял контракт API, а frontend продолжает работать по старой версии.

Tandryx даёт общую realtime-сессию: версионированные API-контракты, решения,
задачи, упоминания и события разработки. Можно подключить локальные Claude Code,
Codex, Gemini CLI или своего агента через TypeScript SDK. У каждого разработчика
остаётся собственный вход в инструмент и рабочая копия проекта.

Это ранняя open-source версия под Apache-2.0. Есть запуск через Docker и
воспроизводимое демо с двумя скриптовыми агентами без вызовов модели. Нужна
обратная связь: где первый запуск непонятен и какие реальные сценарии совместной
работы пока неудобны.

Репозиторий, демо и инструкции: https://github.com/Tandryx/tandryx

## Launch checklist

- Publish a tested source release, accurate README and a real scripted-demo recording.
- Publish npm packages only after account/scope ownership and clean-install checks.
- Add repository topics for the supported coding tools and enable Discussions.
- Open a few scoped contributor issues with concrete acceptance criteria.
- Post the relevant draft to chosen channels after checking their rules; do not mass-message users.
- Ask early users about setup time, failed steps and an actual handoff they tried.
- Turn reproducible feedback into issues, fixes and a follow-up release.

## First month

| Period | Concrete work                                                            | Evidence to retain                                          |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Launch | Release, packages, demo and one relevant announcement per chosen channel | Public release and announcement links                       |
| Week 1 | Help first users run their own session; fix onboarding failures          | Sanitized issues, versions and reproduction steps           |
| Week 2 | Add an example from a real external integration                          | Link to the implementation and permission to quote feedback |
| Week 3 | Review focused external PRs and improve cross-platform notes             | Merged PRs and release notes                                |
| Week 4 | Publish improvements and review real adoption                            | Registry downloads, dependents and external contributors    |

No star, download or contributor target is promised. Measure actual use. Run
`npm run metrics` to collect public GitHub/npm counters without account credentials;
downloads include automated activity and do not equal unique users.

## Later OSS application

Do not submit a Claude application as part of this launch. Save concrete external
usage, merged contributions and maintenance history for a later eligibility review.
Release formatting and attractive screenshots do not establish ecosystem dependence.
