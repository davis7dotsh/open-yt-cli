/**
 * `oytc subscription list` — ports `subscriptionCommand()` from
 * `internal/cli/resources.go`.
 *
 * Two subtleties:
 *
 *  1. `validateParts` runs FIRST in RunE and inspects the RESOLVED parts —
 *     `partsOr(api.parts, "snippet,contentDetails")` — so the default value is
 *     also scanned. It happens to contain no forbidden part, but the resolution
 *     order is reproduced faithfully because `--parts subscriberSnippet` must be
 *     rejected before the `--order` enum and before the channel/id XOR.
 *  2. `--order`'s `--id` incompatibility compares against the literal default
 *     `"relevance"`, not "was the flag changed". So `--id X --order relevance`
 *     is accepted and `--id X --order ""` is rejected. Verified both ways
 *     against the reference binary.
 *
 * Note the two defaults differ from `comment threads`: here the default is
 * `relevance` and the allowed set is `alphabetical, relevance`.
 */

import { Effect } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { UsageError } from "../domain/errors.ts"
import { subscriptionListColumns } from "../output/columns.ts"
import {
  apiFlags,
  exactArgs,
  listFlags,
  partsOr,
  runList,
  setValues,
  validateEnum,
  validateListFlags,
  validateParts
} from "./playlist.ts"

/** `subscription list` — page size 1..50, default 25. No `--hl`. */
export const subscriptionListCommand = Command.make(
  "list",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    channel: Flag.string("channel").pipe(
      Flag.withDefault(""),
      Flag.withDescription("subscriber channel ID")
    ),
    id: Flag.string("id").pipe(
      Flag.withDefault(""),
      Flag.withDescription("comma-separated subscription IDs")
    ),
    order: Flag.string("order").pipe(
      Flag.withDefault("relevance"),
      Flag.withDescription("alphabetical or relevance (default \"relevance\")")
    ),
    forChannel: Flag.string("for-channel").pipe(
      Flag.withDefault(""),
      Flag.withDescription("only subscriptions to this channel ID")
    ),
    ...listFlags(25, 50),
    ...apiFlags
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const bounds = validateListFlags(input, 50)
      if (bounds !== undefined) return yield* Effect.fail(bounds)

      const part = partsOr(input.parts, "snippet,contentDetails")
      const parts = validateParts(part, "subscriberSnippet")
      if (parts !== undefined) return yield* Effect.fail(parts)
      const order = validateEnum("--order", input.order, "alphabetical", "relevance")
      if (order !== undefined) return yield* Effect.fail(order)

      // Go writes this as `(channelID == "") == (ids == "")`: both set or
      // neither set is an error.
      if ((input.channel === "") === (input.id === "")) {
        return yield* Effect.fail(
          new UsageError({ message: "provide exactly one of --channel or --id" })
        )
      }
      // Literal-default comparison, deliberately not "flag was changed".
      if (input.id !== "" && (input.forChannel !== "" || input.order !== "relevance")) {
        return yield* Effect.fail(
          new UsageError({ message: "--for-channel and --order are incompatible with --id" })
        )
      }

      const params = setValues(
        [["part", part]],
        [
          ["channelId", input.channel],
          ["id", input.id],
          ["order", input.order],
          ["forChannelId", input.forChannel],
          ["fields", input.fields]
        ]
      )
      yield* runList("subscriptions", params, input, subscriptionListColumns)
    })
).pipe(Command.withDescription("List subscriptions by channel or subscription IDs"))

/** The `subscription` group. Bare `oytc subscription` prints help and exits 0. */
export const subscriptionCommand = Command.make("subscription").pipe(
  Command.withDescription("Read public channel subscriptions"),
  Command.withSubcommands([subscriptionListCommand])
)
