/**
 * `Prompts` — the port of `App.readSecret` / `App.stdinReader` in
 * `internal/cli/app.go`, plus the confirmation read in `internal/cli/skills.go`.
 *
 * Three properties are load-bearing and each one exists because getting it
 * wrong breaks a documented workflow:
 *
 * 1. **ONE shared stdin reader, for every prompt.** `login --oauth` asks for a
 *    client ID and then a client secret. A buffered read for the first prompt
 *    routinely pulls the second line into its buffer too; a fresh reader for
 *    the second prompt would never see those bytes. Go's comment on
 *    `stdinReader()` says exactly this. The module keeps one byte buffer and
 *    every prompt drains it before touching the file descriptor.
 *
 * 2. **`readSecret` must not require a TTY.** `secret-manager | oytc login` is
 *    a documented workflow. On a TTY the terminal is put in raw mode so the
 *    secret is not echoed; on a pipe it is an ordinary line read, and EOF is
 *    NOT an error there (Go: `if err != nil && !errors.Is(err, io.EOF)`).
 *    Note the asymmetry with `readLine`, where a read error with an empty
 *    result IS fatal — that difference is Go's, and it is reproduced.
 *
 * 3. **Prompts are written to stderr.** stdout stays clean so
 *    `oytc ... --format json | jq` keeps working while a prompt is on screen.
 *
 * Ownership of the surrounding whitespace, so callers do not double up:
 *   - `readLine` writes the prompt and nothing else (the terminal echoes the
 *     user's Enter; a pipe produces no echo, and Go printed nothing either).
 *   - `readSecret` writes the prompt, then a newline after the read, because
 *     echo was suppressed and nothing else would end the line.
 *   - `confirm` writes the block, then a newline after a *successful* read —
 *     on a read failure Go returned before printing it.
 *
 * Error messages carry only the underlying reason ("EOF"), never a prefix.
 * The command layer adds `read OAuth client ID: `, `read API key: `,
 * `read confirmation: ` etc., matching Go's `fmt.Errorf("...: %w", err)`.
 */

import * as fs from "node:fs"
import { Effect, Layer, Redacted } from "effect"
import { OperationalError } from "../domain/errors.ts"
import { Prompts, type PromptsShape } from "../services/index.ts"

const LF = 0x0a
const CR = 0x0d
const ETX = 0x03 // Ctrl-C
const BACKSPACE = 0x08
const DEL = 0x7f

/** Raised from the raw-mode loop when the user presses Ctrl-C. */
const INTERRUPTED = Symbol.for("oytc/prompts/interrupted")

/**
 * The host seam. Production wires this to fds 0 and 2; tests substitute a
 * scripted buffer so the shared-reader behaviour can be asserted without a
 * terminal.
 */
export interface PromptIO {
  /** Read up to `size` bytes. An empty result means EOF. Blocking. */
  readonly read: (size: number) => Uint8Array
  /** Write to stderr. */
  readonly writeError: (text: string) => void
  readonly isInputTTY: boolean
  /** Present only when the input can suppress echo. */
  readonly setRawMode?: ((enabled: boolean) => void) | undefined
}

const CHUNK = 4096

const hostIO = (): PromptIO => {
  const stdin = process.stdin as unknown as {
    isTTY?: boolean
    setRawMode?: (enabled: boolean) => void
  }
  const isInputTTY = stdin.isTTY === true
  return {
    read: (size) => {
      const buffer = new Uint8Array(size)
      for (;;) {
        try {
          const read = fs.readSync(0, buffer, 0, size, null)
          return buffer.subarray(0, read)
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          // A non-blocking tty has nothing ready yet: wait and ask again.
          if (code === "EAGAIN") {
            Bun.sleepSync(5)
            continue
          }
          // Both spellings mean "the descriptor is done".
          if (code === "EOF" || code === "ENXIO") return new Uint8Array(0)
          throw error
        }
      }
    },
    writeError: (text) => {
      fs.writeSync(2, text)
    },
    isInputTTY,
    setRawMode:
      isInputTTY && typeof stdin.setRawMode === "function"
        ? (enabled: boolean) => stdin.setRawMode!(enabled)
        : undefined
  }
}

/** What a line read produced. `endedAtEof` mirrors bufio's trailing `io.EOF`. */
interface LineRead {
  /** The line without its terminator. */
  readonly line: string
  /**
   * True when input ended before a `\n` was seen. Go's `bufio.ReadString`
   * returns `io.EOF` in exactly this case, including when it read partial
   * data first, so callers reproduce Go's "tolerate the error if we still got
   * something" logic off this flag.
   */
  readonly endedAtEof: boolean
  /**
   * Byte count of what `ReadString` returned, terminator INCLUDED.
   *
   * `skills.go` gates on `len(answer) == 0`, i.e. on the raw string — so a
   * lone `"\r"` at EOF is a *cancel* there, not a read failure, even though the
   * trimmed line is empty. Testing `line.length` instead would turn that into
   * `read confirmation: EOF`. Verified against Go.
   */
  readonly rawLength: number
}

const decoder = new TextDecoder()

/**
 * The one buffered reader. Bytes pulled from the descriptor for one prompt
 * stay here and are handed to the next prompt, which is the entire point.
 */
class SharedStdin {
  private pending: Uint8Array = new Uint8Array(0)
  private exhausted = false

  constructor(private readonly io: PromptIO) {}

  private take(count: number): Uint8Array {
    const taken = this.pending.subarray(0, count)
    this.pending = this.pending.slice(count)
    return taken
  }

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.pending.length + chunk.length)
    merged.set(this.pending, 0)
    merged.set(chunk, this.pending.length)
    this.pending = merged
  }

  /** Whether a complete line is already buffered — no descriptor read needed. */
  private bufferedLineEnd(): number {
    return this.pending.indexOf(LF)
  }

  /** Go's `bufio.Reader.ReadString('\n')`, minus the delimiter. */
  readLine(): LineRead {
    for (;;) {
      const end = this.bufferedLineEnd()
      if (end >= 0) {
        const raw = this.take(end + 1)
        return {
          line: stripTerminator(decoder.decode(raw)),
          endedAtEof: false,
          rawLength: raw.length
        }
      }
      if (this.exhausted) {
        const raw = this.take(this.pending.length)
        return {
          line: stripTerminator(decoder.decode(raw)),
          endedAtEof: true,
          rawLength: raw.length
        }
      }
      const chunk = this.io.read(CHUNK)
      if (chunk.length === 0) this.exhausted = true
      else this.append(chunk)
    }
  }

  /**
   * A line read with echo suppressed.
   *
   * Buffered bytes win: if a full line is already in hand there is nothing to
   * suppress and no reason to touch the terminal. Otherwise the descriptor is
   * put in raw mode and drained a byte at a time, because raw mode also turns
   * off the driver's line editing — backspace and Ctrl-C become our job. Go
   * got line editing for free by clearing only `ECHO` via termios, which Node
   * and Bun do not expose.
   */
  readSecretLine(): LineRead {
    if (this.bufferedLineEnd() >= 0 || this.io.setRawMode === undefined) return this.readLine()

    const setRawMode = this.io.setRawMode
    const collected: Array<number> = []
    setRawMode(true)
    try {
      for (;;) {
        // Bytes an earlier prompt over-read go through the SAME rules as bytes
        // typed now. Seeding `collected` with them verbatim instead would let a
        // trailing CR — a CRLF stream whose LF has not arrived yet — end up
        // inside the secret, which neither Go path produces: the pipe path
        // trims it with TrimRight and the TTY path drops CR in readPasswordLine.
        const byte = this.pending.length > 0 ? this.take(1)[0]! : this.readByte()
        if (byte === undefined) {
          this.exhausted = true
          return { line: decodeBytes(collected), endedAtEof: true, rawLength: collected.length }
        }
        if (byte === LF || byte === CR) {
          return {
            line: decodeBytes(collected),
            endedAtEof: false,
            rawLength: collected.length + 1
          }
        }
        if (byte === DEL || byte === BACKSPACE) {
          collected.pop()
          continue
        }
        // Raw mode cleared ISIG, which Go's termios tweak deliberately kept.
        // Surface it as an interrupt so the exit code is still 130.
        if (byte === ETX) throw INTERRUPTED
        collected.push(byte)
      }
    } finally {
      setRawMode(false)
    }
  }

  /** One byte from the descriptor, or `undefined` at EOF. */
  private readByte(): number | undefined {
    const chunk = this.io.read(1)
    return chunk.length === 0 ? undefined : chunk[0]!
  }
}

/**
 * Go's `strings.TrimRight(line, "\r\n")` — it strips a *run* of CR and LF, not
 * just one terminator, so `"abc\r\r\n"` yields `"abc"`.
 */
const stripTerminator = (line: string): string => line.replace(/[\r\n]+$/, "")

const decodeBytes = (bytes: ReadonlyArray<number>): string =>
  decoder.decode(new Uint8Array(bytes))

/**
 * Build a `Prompts` implementation over `io`. Every prompt returned by one
 * call shares a single reader; call this once per process.
 */
export const makePromptsWith = (io: PromptIO): PromptsShape => {
  const stdin = new SharedStdin(io)

  /** Ctrl-C in raw mode unwinds as an Effect interrupt, i.e. exit 130. */
  const attempt = <A>(thunk: () => A): Effect.Effect<A, OperationalError> =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(thunk())
      } catch (error) {
        if (error === INTERRUPTED) return Effect.interrupt
        return Effect.fail(
          new OperationalError({
            message: error instanceof Error ? error.message : String(error),
            cause: error
          })
        )
      }
    })

  return {
    /**
     * Go's OAuth client-ID prompt: an echoed line read where a read error is
     * tolerated as long as something non-blank came back with it.
     */
    readLine: (prompt) =>
      attempt(() => {
        io.writeError(prompt)
        return stdin.readLine()
      }).pipe(
        Effect.flatMap((read) =>
          read.endedAtEof && read.line.trim() === ""
            ? Effect.fail(new OperationalError({ message: "EOF" }))
            : Effect.succeed(read.line)
        )
      ),

    /**
     * Go's `readSecret`: no echo on a TTY, a plain line read on a pipe, and
     * EOF is never an error. The trailing newline is ours to print because
     * nothing echoed the user's Enter.
     */
    readSecret: (prompt) =>
      attempt(() => {
        io.writeError(prompt)
        const read = stdin.readSecretLine()
        io.writeError("\n")
        return Redacted.make(read.line)
      }),

    /**
     * Go's `skills install` confirmation. Go built a fresh `bufio.Reader`
     * here; the shared reader is used instead — strictly safer, and identical
     * in behaviour because this is the command's only prompt.
     */
    confirm: (block) =>
      attempt(() => {
        io.writeError(block)
        return stdin.readLine()
      }).pipe(
        Effect.flatMap((read) => {
          // A read error with zero bytes is fatal; one that still produced
          // bytes is tolerated. Go printed the trailing newline only after
          // clearing that check. The check is on the RAW string, terminator
          // included — a lone "\r" at EOF cancels rather than erroring.
          if (read.endedAtEof && read.rawLength === 0) {
            return Effect.fail(new OperationalError({ message: "EOF" }))
          }
          io.writeError("\n")
          const answer = read.line.trim().toLowerCase()
          return Effect.succeed(answer === "y" || answer === "yes")
        })
      )
  }
}

export const makePrompts: Effect.Effect<PromptsShape> = Effect.sync(() =>
  makePromptsWith(hostIO())
)

export const PromptsLive = Layer.effect(Prompts, makePrompts)

/**
 * A scripted `PromptIO` for tests: `input` is delivered in `chunkSize` pieces
 * so the shared-reader invariant (bytes pulled for one prompt reaching the
 * next) is actually exercised rather than assumed.
 */
export const testPromptIO = (
  input: string,
  options?: { readonly isInputTTY?: boolean; readonly chunkSize?: number }
): PromptIO & {
  readonly errorOutput: () => string
  /** Every setRawMode call, so a test can prove echo really was suppressed. */
  readonly rawModeCalls: () => ReadonlyArray<boolean>
} => {
  const bytes = new TextEncoder().encode(input)
  const chunkSize = options?.chunkSize ?? CHUNK
  const written: Array<string> = []
  const rawModeCalls: Array<boolean> = []
  let offset = 0
  const isInputTTY = options?.isInputTTY ?? false
  return {
    read: (size) => {
      const take = Math.min(size, chunkSize, bytes.length - offset)
      if (take <= 0) return new Uint8Array(0)
      const slice = bytes.subarray(offset, offset + take)
      offset += take
      return slice
    },
    writeError: (text) => {
      written.push(text)
    },
    isInputTTY,
    setRawMode: isInputTTY
      ? (enabled: boolean) => {
          rawModeCalls.push(enabled)
        }
      : undefined,
    errorOutput: () => written.join(""),
    rawModeCalls: () => rawModeCalls
  }
}
