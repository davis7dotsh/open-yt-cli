/**
 * `oytc comment {get,replies,threads}` — ports `commentCommand()` and friends
 * from `internal/cli/resources.go`.
 *
 * Two things here are easy to get wrong and are both pinned by tests:
 *
 *  1. **Batch size is 100, not 50.** `comment get` groups ids in hundreds;
 *     every other by-ID command in the CLI uses 50.
 *  2. **`--order` is compared against the literal default string**, not against
 *     "was the flag changed". `comment threads --id X --order time` is accepted
 *     because the VALUE equals the default, so explicitly passing the default
 *     alongside `--id` is legal — and `--order ""` is REJECTED even though it
 *     means "unset", because `"" != "time"`. Verified against the reference
 *     binary both ways.
 *
 * Shared helpers come from `./playlist.ts` — see the header there for why they
 * live in this package rather than in P8a's `validate.ts`/`fields.ts`.
 */

import { Effect } from "effect"
import { Argument, Command, Flag } from "../effect.ts"
import { UsageError } from "../domain/errors.ts"
import { commentColumns, commentThreadsColumns } from "../output/columns.ts"
import {
  apiFlags,
  exactArgs,
  listFlags,
  minimumArgs,
  partsOr,
  runBatchGet,
  runList,
  setValues,
  validateEnum,
  validateListFlags
} from "./playlist.ts"

/** `--text-format`, shared by all three leaves. Default `plainText`. */
const textFormatFlag = Flag.string("text-format").pipe(
  Flag.withDefault("plainText"),
  Flag.withDescription("plainText or html (default \"plainText\")")
)

/** `comment get <COMMENT_ID>...` — batch size **100**, `minimumArgs(1)`. */
export const commentGetCommand = Command.make(
  "get",
  {
    args: Argument.string("COMMENT_ID").pipe(Argument.variadic()),
    textFormat: textFormatFlag,
    ...apiFlags
  },
  (input) =>
    Effect.gen(function* () {
      // Go checks arity (cobra Args) before RunE, so the arity error wins over
      // a bad --text-format: `comment get` with no ids reports the argument
      // count even when --text-format is also invalid.
      const arity = minimumArgs(1, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const format = validateEnum("--text-format", input.textFormat, "plainText", "html")
      if (format !== undefined) return yield* Effect.fail(format)

      yield* runBatchGet({
        resource: "comments",
        ids: input.args,
        batchSize: 100,
        part: partsOr(input.parts, "snippet"),
        fields: input.fields,
        extra: [["textFormat", input.textFormat]],
        defaultColumns: commentColumns
      })
    })
).pipe(Command.withDescription("Get comments by ID"))

/**
 * `comment replies <PARENT_COMMENT_ID>` — page size 1..**100**, default **20**.
 */
export const commentRepliesCommand = Command.make(
  "replies",
  {
    args: Argument.string("PARENT_COMMENT_ID").pipe(Argument.variadic()),
    textFormat: textFormatFlag,
    ...listFlags(20, 100),
    ...apiFlags
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(1, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const bounds = validateListFlags(input, 100)
      if (bounds !== undefined) return yield* Effect.fail(bounds)
      const format = validateEnum("--text-format", input.textFormat, "plainText", "html")
      if (format !== undefined) return yield* Effect.fail(format)

      const params = setValues(
        [
          ["part", partsOr(input.parts, "snippet")],
          ["parentId", input.args[0]!]
        ],
        [
          ["textFormat", input.textFormat],
          ["fields", input.fields]
        ]
      )
      yield* runList("comments", params, input, commentColumns)
    })
).pipe(Command.withDescription("List replies to a top-level comment"))

/**
 * `comment threads` — page size 1..**100**, default **20**.
 *
 * RunE check order (each verified against the reference binary):
 *   1. `--text-format` enum        (beats a bad `--order`)
 *   2. `--order` enum
 *   3. exactly one of `--video` / `--channel` / `--id`
 *   4. `--id` incompatibility with `--order`/`--search`
 *
 * Step 4 uses `order != "time"` — the DEFAULT STRING — so `--id X --order time`
 * passes while `--id X --order ""` fails.
 */
export const commentThreadsCommand = Command.make(
  "threads",
  {
    args: Argument.string("ARG").pipe(Argument.variadic()),
    video: Flag.string("video").pipe(Flag.withDefault(""), Flag.withDescription("video ID")),
    channel: Flag.string("channel").pipe(
      Flag.withDefault(""),
      Flag.withDescription("channel ID")
    ),
    id: Flag.string("id").pipe(
      Flag.withDefault(""),
      Flag.withDescription("comma-separated thread IDs")
    ),
    order: Flag.string("order").pipe(
      Flag.withDefault("time"),
      Flag.withDescription("time or relevance (default \"time\")")
    ),
    search: Flag.string("search").pipe(
      Flag.withDefault(""),
      Flag.withDescription("restrict to comments containing these terms")
    ),
    textFormat: textFormatFlag,
    ...listFlags(20, 100),
    ...apiFlags
  },
  (input) =>
    Effect.gen(function* () {
      const arity = exactArgs(0, input.args)
      if (arity !== undefined) return yield* Effect.fail(arity)
      const bounds = validateListFlags(input, 100)
      if (bounds !== undefined) return yield* Effect.fail(bounds)

      const format = validateEnum("--text-format", input.textFormat, "plainText", "html")
      if (format !== undefined) return yield* Effect.fail(format)
      const order = validateEnum("--order", input.order, "time", "relevance")
      if (order !== undefined) return yield* Effect.fail(order)

      const filters = [input.video, input.channel, input.id].filter((v) => v !== "").length
      if (filters !== 1) {
        return yield* Effect.fail(
          new UsageError({ message: "provide exactly one of --video, --channel, or --id" })
        )
      }
      // Literal-default comparison, deliberately not "flag was changed".
      if (input.id !== "" && (input.order !== "time" || input.search !== "")) {
        return yield* Effect.fail(
          new UsageError({ message: "--order and --search are incompatible with --id" })
        )
      }

      const params = setValues(
        [["part", partsOr(input.parts, "snippet,replies")]],
        [
          ["videoId", input.video],
          ["allThreadsRelatedToChannelId", input.channel],
          ["id", input.id],
          ["order", input.order],
          ["searchTerms", input.search],
          ["textFormat", input.textFormat],
          ["fields", input.fields]
        ]
      )
      yield* runList("commentThreads", params, input, commentThreadsColumns)
    })
).pipe(Command.withDescription("List comment threads by video, channel, or IDs"))

/** The `comment` group. Bare `oytc comment` prints help and exits 0. */
export const commentCommand = Command.make("comment").pipe(
  Command.withDescription("Read public comments and comment threads"),
  Command.withSubcommands([commentGetCommand, commentRepliesCommand, commentThreadsCommand])
)
