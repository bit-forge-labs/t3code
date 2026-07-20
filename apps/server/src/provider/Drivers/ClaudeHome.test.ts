import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeDiscoveryEnvironment,
  readClaudeConfigDirAnthropicEnv,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });

  describe("readClaudeConfigDirAnthropicEnv", () => {
    it.effect("reads the gateway env from settings.json in the config dir", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(
          path.join(dir, "settings.json"),
          `{ "env": { "ANTHROPIC_BASE_URL": "http://localhost:8317", "ANTHROPIC_AUTH_TOKEN": "tok-1", "UNRELATED": "ignored" } }`,
        );

        const overlay = yield* readClaudeConfigDirAnthropicEnv({ homePath: dir });
        expect(overlay).toEqual({
          ANTHROPIC_BASE_URL: "http://localhost:8317",
          ANTHROPIC_AUTH_TOKEN: "tok-1",
        });
      }).pipe(Effect.scoped),
    );

    it.effect("lets settings.local.json override settings.json", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(
          path.join(dir, "settings.json"),
          `{ "env": { "ANTHROPIC_BASE_URL": "http://base" } }`,
        );
        yield* fileSystem.writeFileString(
          path.join(dir, "settings.local.json"),
          `{ "env": { "ANTHROPIC_BASE_URL": "http://local" } }`,
        );

        const overlay = yield* readClaudeConfigDirAnthropicEnv({ homePath: dir });
        expect(overlay.ANTHROPIC_BASE_URL).toBe("http://local");
      }).pipe(Effect.scoped),
    );

    it.effect("returns an empty overlay when no settings files exist", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dir = yield* fileSystem.makeTempDirectoryScoped();
        const overlay = yield* readClaudeConfigDirAnthropicEnv({ homePath: dir });
        expect(overlay).toEqual({});
      }).pipe(Effect.scoped),
    );

    it.effect("ignores malformed settings JSON", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(path.join(dir, "settings.json"), "{ not json");
        const overlay = yield* readClaudeConfigDirAnthropicEnv({ homePath: dir });
        expect(overlay).toEqual({});
      }).pipe(Effect.scoped),
    );
  });

  describe("mergeClaudeDiscoveryEnvironment", () => {
    it("keeps existing process env values over the overlay", () => {
      const merged = mergeClaudeDiscoveryEnvironment(
        { ANTHROPIC_BASE_URL: "http://real" },
        { ANTHROPIC_BASE_URL: "http://overlay", ANTHROPIC_AUTH_TOKEN: "tok" },
      );
      expect(merged.ANTHROPIC_BASE_URL).toBe("http://real");
      expect(merged.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    });

    it("fills a blank process env value from the overlay", () => {
      const merged = mergeClaudeDiscoveryEnvironment(
        { ANTHROPIC_BASE_URL: "   " },
        { ANTHROPIC_BASE_URL: "http://overlay" },
      );
      expect(merged.ANTHROPIC_BASE_URL).toBe("http://overlay");
    });

    it("returns the base env unchanged for an empty overlay", () => {
      const base = { FOO: "bar" };
      expect(mergeClaudeDiscoveryEnvironment(base, {})).toBe(base);
    });
  });
});
