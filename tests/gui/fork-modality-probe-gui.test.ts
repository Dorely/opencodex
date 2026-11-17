import { describe, expect, test } from "bun:test";
import { probeCandidates } from "../../gui/src/fork/modality-probe-candidates";
import type { ModelOption } from "../../gui/src/components/combo-workspace-types";

// Fork: the combo editor offers an image test for targets that do not declare image input.
describe("modality probe candidates", () => {
  test("lists routed targets without declared image input, once each", () => {
    const models = [
      { provider: "cc", id: "carbon" },
      { provider: "cc", id: "vision", inputModalities: ["text", "image"] },
      { provider: "cc", id: "text", inputModalitiesDeclared: ["text"] },
      { provider: "cc", id: "widened", inputModalities: ["text", "image"], visionSidecarConsumer: true },
      { provider: "openai", id: "gpt-6.1-sol" },
    ] as unknown as ModelOption[];
    const targets = ["carbon", "vision", "text", "widened", "carbon", "missing"].map(model => ({ provider: "cc", model }))
      .concat([{ provider: "openai", model: "gpt-6.1-sol" }]);
    expect(probeCandidates(targets, models).map(row => row.model)).toEqual(["carbon", "text", "widened"]);
  });
});
