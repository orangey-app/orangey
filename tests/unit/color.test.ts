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
  test("hex parsing and the OKLab round trip give back what went in", () => {
    assert.deepEqual(hexToRgb("#fff"), { r: 1, g: 1, b: 1 });
    assert.deepEqual(hexToRgb("000000"), { r: 0, g: 0, b: 0 });
    assert.equal(rgbToHex(hexToRgb("#c96a1f")), "#c96a1f");
    assert.throws(() => hexToRgb("orange"));
    assert.ok(isHex("#abc") && isHex("aabbcc") && !isHex("#gg0000") && !isHex(42));
    // Colours make the trip to OKLab and back on every wheel, so any drift
    // here would show up as a colour slowly changing as it is edited.
    for (const hex of ["#000000", "#ffffff", "#c96a1f", "#2f6f7c", "#8b9b74"]) {
      assert.equal(rgbToHex(oklabToRgb(hexToOklab(hex))), hex);
    }
    assert.ok(hexToOklab("#000000").L < 0.001);
    assert.ok(Math.abs(hexToOklab("#ffffff").L - 1) < 0.001);
    assert.equal(mix("#000000", "#ffffff", 0), "#000000");
    assert.equal(mix("#000000", "#ffffff", 1), "#ffffff");
    assert.ok(Math.abs(hexToOklab(mix("#000000", "#ffffff", 0.5)).L - 0.5) < 0.01);
  });

  test("distance is zero for one colour against itself, and hue wraps round the circle", () => {
    assert.equal(deltaE(hexToOklab("#c96a1f"), hexToOklab("#c96a1f")), 0);
    const near = deltaE(hexToOklab("#c96a1f"), hexToOklab("#cb6c21"));
    const far = deltaE(hexToOklab("#c96a1f"), hexToOklab("#27476b"));
    assert.ok(near < 0.02 && far > 0.3, `${near} / ${far}`);
    const red = hexToOklab("#c0392b");
    assert.ok(hueDifference(red, hexToOklab("#b03a2e")) < 10);
    assert.ok(hueDifference(hexToOklab("#2f6f7c"), red) > 90);
  });

  test("labelFor puts readable ink on a fill, light or dark", () => {
    // The reference values: black on white is 21:1, mid grey on white 4.48:1.
    assert.ok(Math.abs(contrastRatio(hexToRgb("#000"), hexToRgb("#fff")) - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio(hexToRgb("#777"), hexToRgb("#fff")) - 4.48) < 0.05);

    const fills = [
      ["#ffffff", "white"],
      ["#f3e9d2", "pale sand"],
      ["#c96a1f", "mid orange"],
      ["#767676", "the worst-case mid grey"],
      ["#2f6f7c", "deep teal"],
      ["#27476b", "dark blue"],
      ["#000000", "black"],
    ];
    for (const [hex, what] of fills) {
      const label = labelFor(hex);
      assert.ok(label.ratio >= 4.5, `${what}: only ${label.ratio.toFixed(2)}:1`);
      // The ratio the caller is told must be the ratio the drawn colours have.
      const actual = contrastRatio(hexToRgb(label.fill), hexToRgb(label.ink));
      assert.ok(actual >= 4.49, `${what}: recomputed ${actual.toFixed(2)}:1`);
      assert.equal(label.nudges, 0, `${what} should not need the fill nudging at 4.5:1`);
      assert.equal(label.fill, hex, `${what}: the fill was changed when it did not have to be`);
    }

    // At 4.5:1 almost every colour works as it is — the worst case sits right
    // on the threshold. Ask for a stricter ratio to exercise the nudge path.
    const hard = labelFor("#767676", 7);
    assert.ok(hard.nudges > 0, "a stricter target should have needed a nudge");
    assert.notEqual(hard.fill, "#767676");
    assert.ok(hard.ratio >= 7, `reached only ${hard.ratio}`);
  });

  test("the deuteranopia simulation collapses red and green but leaves blue alone", () => {
    const red = hexToRgb("#c0392b");
    const green = hexToRgb("#2e8b32");
    const before = deltaE(rgbToOklab(red), rgbToOklab(green));
    const after = deltaE(rgbToOklab(simulateDeuteranopia(red)), rgbToOklab(simulateDeuteranopia(green)));
    assert.ok(after < before, `${after} should be less than ${before}`);
    const blue = hexToRgb("#27476b");
    assert.ok(deltaE(rgbToOklab(blue), rgbToOklab(simulateDeuteranopia(blue))) < 0.12);
  });
});
