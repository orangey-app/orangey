import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  deltaE,
  hexToOklab,
  hexToRgb,
  hueDifference,
  isHex,
  labelFor,
  mix,
  oklabToRgb,
  rgbToHex,
  rgbToOklab,
  simulateDeuteranopia,
} from "../../src/core/color.ts";

describe("colour maths", () => {
  test("hex parsing accepts the forms people actually type", () => {
    assert.deepEqual(hexToRgb("#fff"), { r: 1, g: 1, b: 1 });
    assert.deepEqual(hexToRgb("000000"), { r: 0, g: 0, b: 0 });
    assert.equal(rgbToHex(hexToRgb("#c96a1f")), "#c96a1f");
    assert.throws(() => hexToRgb("orange"));
    assert.ok(isHex("#abc") && isHex("aabbcc") && !isHex("#gg0000") && !isHex(42));
  });

  test("OKLab round-trips through sRGB", () => {
    for (const hex of ["#000000", "#ffffff", "#c96a1f", "#2f6f7c", "#8b9b74"]) {
      assert.equal(rgbToHex(oklabToRgb(hexToOklab(hex))), hex);
    }
  });

  test("black and white sit at the ends of the lightness scale", () => {
    assert.ok(hexToOklab("#000000").L < 0.001);
    assert.ok(Math.abs(hexToOklab("#ffffff").L - 1) < 0.001);
  });

  test("distance is zero for identical colours and larger for dissimilar ones", () => {
    assert.equal(deltaE(hexToOklab("#c96a1f"), hexToOklab("#c96a1f")), 0);
    const near = deltaE(hexToOklab("#c96a1f"), hexToOklab("#cb6c21"));
    const far = deltaE(hexToOklab("#c96a1f"), hexToOklab("#27476b"));
    assert.ok(near < 0.02 && far > 0.3, `${near} / ${far}`);
  });

  test("hue difference wraps around the circle", () => {
    const red = hexToOklab("#c0392b");
    const alsoRed = hexToOklab("#b03a2e");
    assert.ok(hueDifference(red, alsoRed) < 10);
    assert.ok(hueDifference(hexToOklab("#2f6f7c"), red) > 90);
  });

  test("contrast matches the WCAG reference values", () => {
    assert.ok(Math.abs(contrastRatio(hexToRgb("#000"), hexToRgb("#fff")) - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio(hexToRgb("#777"), hexToRgb("#fff")) - 4.48) < 0.05);
  });

  test("label choice reaches 4.5:1, nudging the fill only when it has to", () => {
    const easy = labelFor("#2f6f7c");
    assert.equal(easy.nudges, 0);
    assert.ok(easy.ratio >= 4.5);
    // At 4.5:1 almost every colour works as it is — the worst case sits right
    // on the threshold. Ask for a stricter ratio to exercise the nudge path.
    const hard = labelFor("#767676", 7);
    assert.ok(hard.nudges > 0, "a stricter target should have needed a nudge");
    assert.notEqual(hard.fill, "#767676");
    assert.ok(hard.ratio >= 7, `reached only ${hard.ratio}`);
    assert.ok(labelFor("#767676").ratio >= 4.5);
  });

  test("deuteranopia simulation collapses red and green towards each other", () => {
    const red = hexToRgb("#c0392b");
    const green = hexToRgb("#2e8b32");
    const before = deltaE(rgbToOklab(red), rgbToOklab(green));
    const after = deltaE(rgbToOklab(simulateDeuteranopia(red)), rgbToOklab(simulateDeuteranopia(green)));
    assert.ok(after < before, `${after} should be less than ${before}`);
  });

  test("blue is largely unaffected by the deuteranopia simulation", () => {
    const blue = hexToRgb("#27476b");
    const shifted = simulateDeuteranopia(blue);
    assert.ok(deltaE(rgbToOklab(blue), rgbToOklab(shifted)) < 0.12);
  });

  test("mixing interpolates and hits both ends exactly", () => {
    assert.equal(mix("#000000", "#ffffff", 0), "#000000");
    assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
    const middle = hexToOklab(mix("#000000", "#ffffff", 0.5));
    assert.ok(Math.abs(middle.L - 0.5) < 0.01);
  });
});
