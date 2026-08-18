<!--
Thanks for contributing. Small, focused changes with a test are the easiest to
merge. See CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. The why matters more than the what. -->

## Why

<!-- What problem this solves, or what it makes possible. -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass
- [ ] A test fails without this change, if it fixes a bug
- [ ] Nothing provider-specific entered `packages/protocol` or `packages/server`
- [ ] Session writes still go through `EventLog`

## Protocol impact

<!--
Delete this section if the wire format is untouched.

Otherwise: is the change additive (new event type, new optional field) or
breaking (removed field, changed shape)? Additive changes keep agentmesh/v1 and
need docs/PROTOCOL.md updated in the same commit. Breaking changes need a
migration path and a version bump.
-->

None.
