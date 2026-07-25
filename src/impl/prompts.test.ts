/**
 * Tests for the shared stdin reader.
 *
 * Go has no dedicated test for `readSecret` — it is covered indirectly through
 * `internal/cli/app_test.go`, which swaps `app.ReadSecret` for a stub. These
 * tests therefore target the three properties the port must not regress:
 * one shared reader, no TTY requirement, prompts on stderr.
 */

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Redacted } from "effect"
import { makePromptsWith, testPromptIO, type PromptIO } from "./prompts.ts"
import { OperationalError } from "../domain/errors.ts"

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

const exitOf = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(Effect.exit(effect))

const messageOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (exit._tag !== "Failure") return ""
  const error = Cause.findErrorOption(exit.cause)
  return error._tag === "Some" && error.value instanceof OperationalError ? error.value.message : ""
}

/** Control bytes the raw-mode loop has to interpret itself. */
const DEL = String.fromCharCode(0x7f)
const BACKSPACE = String.fromCharCode(0x08)
const CTRL_C = String.fromCharCode(0x03)
const CR = String.fromCharCode(0x0d)

describe("shared stdin reader", () => {
  test("consecutive prompts see consecutive lines from one piped stream", async () => {
    // The whole reason Go keeps one bufio.Reader: reading the client ID pulls
    // the secret's bytes into the buffer too. A fresh reader would lose them.
    const io = testPromptIO("client-id\nclient-secret\n")
    const prompts = makePromptsWith(io)

    const id = await run(prompts.readLine("OAuth client ID: "))
    const secret = await run(prompts.readSecret("OAuth client secret: "))

    expect(id).toBe("client-id")
    expect(Redacted.value(secret)).toBe("client-secret")
  })

  test("three prompts in a row stay in order", async () => {
    const io = testPromptIO("one\ntwo\nthree\n")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("a: "))).toBe("one")
    expect(Redacted.value(await run(prompts.readSecret("b: ")))).toBe("two")
    expect(await run(prompts.readLine("c: "))).toBe("three")
  })

  test("a one-byte-at-a-time descriptor produces the same lines", async () => {
    const io = testPromptIO("client-id\nclient-secret\n", { chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("client-id")
    expect(Redacted.value(await run(prompts.readSecret("secret: ")))).toBe("client-secret")
  })

  test("CRLF input has its terminator stripped", async () => {
    const io = testPromptIO(`client-id${CR}\nsecret${CR}\n`)
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("client-id")
    expect(Redacted.value(await run(prompts.readSecret("s: ")))).toBe("secret")
  })

  test("a run of CR/LF is stripped, but an interior CR is kept", async () => {
    // Verified against Go: strings.TrimRight(line, "\r\n") on "abc\r\r\n"
    // yields "abc", and "a\rb\n" yields "a\rb".
    const io = testPromptIO(`abc${CR}${CR}\na${CR}b\n`)
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("x: "))).toBe("abc")
    expect(await run(prompts.readLine("y: "))).toBe(`a${CR}b`)
  })

  test("UTF-8 survives a chunk boundary mid-codepoint", async () => {
    // Split one byte at a time, so the decoder sees partial sequences.
    const io = testPromptIO("héllo→\n", { chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("x: "))).toBe("héllo→")
  })
})

describe("readSecret", () => {
  test("works when stdin is a pipe — no TTY required", async () => {
    // `secret-manager | oytc login` is a documented workflow.
    const io = testPromptIO("piped-api-key\n", { isInputTTY: false })
    const prompts = makePromptsWith(io)
    const secret = await run(prompts.readSecret("YouTube Data API key: "))
    expect(Redacted.value(secret)).toBe("piped-api-key")
  })

  test("EOF without a trailing newline is not an error", async () => {
    // Go: `if err != nil && !errors.Is(err, io.EOF) { return "", err }`.
    const io = testPromptIO("no-newline-at-end")
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("key: ")))).toBe("no-newline-at-end")
  })

  test("an empty line at EOF yields an empty secret, not a failure", async () => {
    // The caller turns "" into the usage error "API key cannot be empty".
    const io = testPromptIO("")
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("key: ")))).toBe("")
  })

  test("the prompt goes to stderr and a newline follows the read", async () => {
    const io = testPromptIO("s3cret\n")
    const prompts = makePromptsWith(io)
    await run(prompts.readSecret("YouTube Data API key: "))
    expect(io.errorOutput()).toBe("YouTube Data API key: \n")
  })

  test("on a TTY, echo is suppressed and restored around the read", async () => {
    const io = testPromptIO("hunter2\n", { isInputTTY: true, chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("hunter2")
    expect(io.rawModeCalls()).toEqual([true, false])
  })

  test("raw mode handles backspace, which the line driver would normally do", async () => {
    // Raw mode clears ICANON, so DEL and BS become our job.
    const io = testPromptIO(`abc${DEL}${BACKSPACE}d\n`, { isInputTTY: true, chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("ad")
  })

  test("raw mode ends the line on a bare CR", async () => {
    const io = testPromptIO(`hunter2${CR}rest\n`, { isInputTTY: true, chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("hunter2")
  })

  test("EOF mid-secret on a TTY returns what was typed, with no error", async () => {
    const io = testPromptIO("partial", { isInputTTY: true, chunkSize: 1 })
    const prompts = makePromptsWith(io)
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("partial")
    expect(io.rawModeCalls()).toEqual([true, false])
  })

  test("Ctrl-C in raw mode interrupts rather than returning a partial secret", async () => {
    // Raw mode also clears ISIG, which Go's termios tweak deliberately kept,
    // so 0x03 has to be turned back into an interrupt by hand (exit 130).
    const io = testPromptIO(`part${CTRL_C}ial\n`, { isInputTTY: true, chunkSize: 1 })
    const prompts = makePromptsWith(io)
    const exit = await exitOf(prompts.readSecret("pw: "))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    // Raw mode is restored even on the way out.
    expect(io.rawModeCalls()).toEqual([true, false])
  })

  test("a partly-buffered CRLF line does not smuggle a CR into the secret", async () => {
    // The previous prompt's read pulled "sec\r" in but not the LF, so the raw
    // loop starts with buffered bytes. Those must go through the same CR/LF
    // rules as typed bytes — Go's pipe path trims with TrimRight and its TTY
    // path drops CR in readPasswordLine, so neither yields "sec\r".
    const io = testPromptIO(`id\nsec${CR}`, { isInputTTY: true })
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("id")
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("sec")
  })

  test("buffered bytes before a typed tail still edit correctly in raw mode", async () => {
    const io = testPromptIO(`id\nabX${BACKSPACE}c\n`, { isInputTTY: true, chunkSize: 5 })
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("id")
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("abc")
  })

  test("a TTY still yields already-buffered bytes without entering raw mode", async () => {
    // The previous prompt's read pulled this line in; nothing left to hide.
    const io = testPromptIO("id\nsecret\n", { isInputTTY: true })
    const prompts = makePromptsWith(io)
    await run(prompts.readLine("id: "))
    expect(Redacted.value(await run(prompts.readSecret("pw: ")))).toBe("secret")
    expect(io.rawModeCalls()).toEqual([])
  })

  test("the secret is Redacted, so an accidental log prints <redacted>", async () => {
    const io = testPromptIO("AIzaTOPSECRET\n")
    const prompts = makePromptsWith(io)
    const secret = await run(prompts.readSecret("key: "))
    expect(String(secret)).not.toContain("AIzaTOPSECRET")
    expect(`${secret}`).toContain("redacted")
  })
})

describe("readLine", () => {
  test("writes the prompt to stderr and echoes nothing itself", async () => {
    const io = testPromptIO("value\n")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("OAuth client ID: "))).toBe("value")
    expect(io.errorOutput()).toBe("OAuth client ID: ")
  })

  test("a partial read at EOF is tolerated when it produced a value", async () => {
    // Go: `if err != nil && strings.TrimSpace(clientID) == "" { return err }`.
    const io = testPromptIO("trailing-value-no-newline")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("trailing-value-no-newline")
  })

  test("EOF with nothing read fails", async () => {
    const io = testPromptIO("")
    const prompts = makePromptsWith(io)
    const exit = await exitOf(prompts.readLine("id: "))
    expect(exit._tag).toBe("Failure")
    expect(messageOf(exit)).toBe("EOF")
  })

  test("EOF with only whitespace read fails — Go trims before the check", async () => {
    const io = testPromptIO("   ")
    const prompts = makePromptsWith(io)
    expect(messageOf(await exitOf(prompts.readLine("id: ")))).toBe("EOF")
  })

  test("surrounding whitespace is left to the caller to trim", async () => {
    // Go trimmed at the call site, not in the reader.
    const io = testPromptIO("  spaced  \n")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("  spaced  ")
  })

  test("a blank line before EOF is a value, not an EOF failure", async () => {
    const io = testPromptIO("\nsecond\n")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.readLine("id: "))).toBe("")
    expect(await run(prompts.readLine("id: "))).toBe("second")
  })
})

describe("confirm", () => {
  test.each([
    ["y\n", true],
    ["yes\n", true],
    ["Y\n", true],
    ["YES\n", true],
    ["  yes  \n", true],
    ["n\n", false],
    ["no\n", false],
    ["nope\n", false],
    ["\n", false],
    ["yep\n", false],
    ["ye\n", false]
  ])("%j -> %s", async (input, expected) => {
    const io = testPromptIO(input)
    const prompts = makePromptsWith(io)
    expect(await run(prompts.confirm("Continue? [y/N] "))).toBe(expected)
  })

  test("writes the block to stderr, then a newline after the read", async () => {
    const block =
      "Install the bundled oytc agent skill?\nDestination: /tmp/oytc\n" +
      "Permission requested: create this directory and write SKILL.md plus references.\n" +
      "Continue? [y/N] "
    const io = testPromptIO("y\n")
    const prompts = makePromptsWith(io)
    await run(prompts.confirm(block))
    expect(io.errorOutput()).toBe(`${block}\n`)
  })

  test("a bare EOF is a read failure, matching Go's zero-bytes check", async () => {
    const io = testPromptIO("")
    const prompts = makePromptsWith(io)
    const exit = await exitOf(prompts.confirm("Continue? [y/N] "))
    expect(exit._tag).toBe("Failure")
    expect(messageOf(exit)).toBe("EOF")
    // Go returned before printing the trailing newline on this path.
    expect(io.errorOutput()).toBe("Continue? [y/N] ")
  })

  test("a lone CR at EOF cancels rather than failing — Go checks the RAW length", async () => {
    // skills.go gates on `len(answer) == 0`, i.e. on the untrimmed string.
    // Verified against Go: input "\r" -> cancelled (answer="\r", err=EOF).
    // Checking the trimmed line instead would turn this into
    // `read confirmation: EOF` and change the exit code.
    const io = testPromptIO(CR)
    const prompts = makePromptsWith(io)
    expect(await run(prompts.confirm("Continue? [y/N] "))).toBe(false)
  })

  test("whitespace-only input at EOF cancels, it is not a read failure", async () => {
    // Go: input "   " -> cancelled (answer="   ", err=EOF).
    const io = testPromptIO("   ")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.confirm("Continue? [y/N] "))).toBe(false)
  })

  test("'yes' with no trailing newline still confirms", async () => {
    // Go tolerated the EOF error because bytes were read.
    const io = testPromptIO("yes")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.confirm("Continue? [y/N] "))).toBe(true)
  })

  test("a declined confirmation leaves the rest of stdin for the next prompt", async () => {
    const io = testPromptIO("no\nleftover\n")
    const prompts = makePromptsWith(io)
    expect(await run(prompts.confirm("Continue? [y/N] "))).toBe(false)
    expect(await run(prompts.readLine("next: "))).toBe("leftover")
  })
})

describe("host failures", () => {
  test("a descriptor error surfaces as an OperationalError, not a defect", async () => {
    const io: PromptIO = {
      read: () => {
        throw new Error("EIO: i/o error")
      },
      writeError: () => {},
      isInputTTY: false
    }
    const prompts = makePromptsWith(io)
    expect(messageOf(await exitOf(prompts.readLine("id: ")))).toBe("EIO: i/o error")
    expect(messageOf(await exitOf(prompts.readSecret("pw: ")))).toBe("EIO: i/o error")
    expect(messageOf(await exitOf(prompts.confirm("Continue? [y/N] ")))).toBe("EIO: i/o error")
  })
})
