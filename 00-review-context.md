# Review Context

## Branch Info

- Base: origin/main (merge-base 148f33c47062562d0678ec8972ed20edf08b1ec9)
- Current: brennanb2025/orca-cli-telemetry

## Changed Files Summary

- M config/tsconfig.cli.json
- M src/cli/dispatch.ts
- A src/cli/telemetry.test.ts
- A src/cli/telemetry.ts
- M src/main/runtime/rpc/methods/index.ts
- A src/main/runtime/rpc/methods/telemetry.test.ts
- A src/main/runtime/rpc/methods/telemetry.ts
- M src/shared/telemetry-events.test.ts
- M src/shared/telemetry-events.ts

## Changed Line Ranges (PR Scope)

| File                                          | Changed Lines                  |
| --------------------------------------------- | ------------------------------ |
| config/tsconfig.cli.json                      | 3-8                            |
| src/cli/dispatch.ts                           | 3, 62-74                       |
| src/cli/telemetry.test.ts                     | 1-181 (new file)               |
| src/cli/telemetry.ts                          | 1-344 (new file)               |
| src/main/runtime/rpc/methods/index.ts         | 11, 25-26                      |
| src/main/runtime/rpc/methods/telemetry.test.ts| 1-131 (new file)               |
| src/main/runtime/rpc/methods/telemetry.ts     | 1-82 (new file)                |
| src/shared/telemetry-events.test.ts           | 10-11, 15, 194-272             |
| src/shared/telemetry-events.ts                | 113-133, 211-220, 246-260      |

## Review Standards Reference

- Follow /review-code standards
- Focus on: correctness, security, performance, maintainability
- Priority levels: Critical > High > Medium > Low

## File Categories

### Electron/Main
- src/main/runtime/rpc/methods/index.ts
- src/main/runtime/rpc/methods/telemetry.ts
- src/main/runtime/rpc/methods/telemetry.test.ts

### Config/Build
- config/tsconfig.cli.json

### Utility/Common
- src/cli/dispatch.ts
- src/cli/telemetry.ts
- src/cli/telemetry.test.ts
- src/shared/telemetry-events.ts
- src/shared/telemetry-events.test.ts

## Skipped Issues (Do Not Re-validate)

- [src/main/runtime/rpc/methods/telemetry.ts:44] | Low | Cosmetic — per-event `.strict()` schemas catch non-object props at the same boundary | params.props z.unknown() doesn't enforce object shape at params layer
- [src/main/runtime/rpc/methods/telemetry.ts:42] | Low | Stylistic — sibling RPC files use the same transform-then-pipe pattern | "Missing event name" error message is misleading for non-string name values
- [config/tsconfig.cli.json:7] | Low | No-harm pre-emptive include; potentially needed for future telemetry shared-code work | `../src/types/**/*` include not currently referenced
- [src/cli/telemetry.ts:283-344] | Low | Significant test infra (tmp socket server) for code with extensive load-bearing comments | defaultSender socket-lifecycle has no integration test
- [src/cli/telemetry.ts:9-10] | Low | Documented design choice — "best-effort, fire-and-forget" per design doc | unref + likely `process.exit` means short commands drop events
- [src/cli/telemetry.ts:220-227] | Low | Documented design choice — "first-write-wins" per design doc | first-failure-wins biases dashboard
- [src/main/runtime/rpc/methods/telemetry.ts:18-19] | Low | Architectural refactor — out of scope for this PR | direct import of `client` instead of routing through `OrcaRuntimeService`
- [src/main/runtime/rpc/methods/telemetry.ts:58-60] | Low | Threat-model says no wire leak; main-side debug log is judgment call | no observability hook for rejected CLI event names
- [src/cli/telemetry.ts:186-204] | Low | Stylistic — `_*ForTests` exports are an existing project pattern | test seams in production module
- [src/cli/telemetry.ts:294-302] | Low | Belt-and-braces is documented; structure works correctly | createConnection sync-throw try/catch awkwardness
- [src/cli/dispatch.ts:3] | Low | Stylistic only | `./telemetry` import not grouped with handler imports

## Iteration State

Current iteration: 1
Last completed phase: Validation
Files fixed this iteration: []
