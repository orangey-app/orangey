import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY,
  facingError,
  hasDedicatedSolid,
  pickTumbleAxes,
  quatFromAxisAngle,
  quatFromTo,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  restQuaternion,
  rotateVec,
  solidForSides,
  vDistance,
  vNormalize,
  type Vec3,
} from "../../src/core/polyhedra.ts";
import { SeededSource } from "../../src/core/rng.ts";

const ALL_SOLIDS = [4, 6, 8, 10, 12, 20, 100];

describe("solids", () => {
  test("each die type is drawn from the right solid, with a face for every value it can roll", () => {
    // sides -> [vertices, edges, faces, sides per face]. The d100 is a d10
    // with a second digit, so it shares the trapezohedron and its ten faces;
    // its hundred values land on those faces in turn.
    const expected: Record<number, [number, number, number, number]> = {
      4: [4, 6, 4, 3],
      6: [8, 12, 6, 4],
      8: [6, 12, 8, 3],
      10: [12, 20, 10, 4],
      12: [20, 30, 12, 5],
      20: [12, 30, 20, 3],
      100: [12, 20, 10, 4],
    };
    for (const sides of ALL_SOLIDS) {
      const [vertices, edges, faces, perFace] = expected[sides];
      const s = solidForSides(sides);
      assert.equal(s.name, `d${sides}`);
      assert.equal(s.vertices.length, vertices, `d${sides}: vertices`);
      assert.equal(s.edges.length, edges, `d${sides}: edges`);
      assert.equal(s.faces.length, faces, `d${sides}: faces`);
      assert.equal(s.faceNormals.length, faces, `d${sides}: one normal per face`);
      for (const face of s.faces) assert.equal(face.length, perFace, `d${sides}: a face with ${face.length} sides`);
      // Every value the die can show must have a face to come to rest on,
      // which for the d100 means wrapping round the ten faces four times over.
      for (let value = 1; value <= sides; value++) {
        const q = restQuaternion(s, (value - 1) % s.faces.length);
        assert.ok(facingError(s, q) < 1e-6, `d${sides}: ${value} does not land square-on`);
      }
    }
  });

  test("a die with no solid of its own tumbles as a cube but keeps its name", () => {
    for (const sides of [3, 7, 30, 1000]) {
      const s = solidForSides(sides);
      assert.equal(s.name, `d${sides}`);
      assert.equal(s.vertices.length, 8);
      assert.equal(s.edges.length, 12);
      assert.equal(hasDedicatedSolid(sides), false);
    }
    for (const sides of ALL_SOLIDS) assert.equal(hasDedicatedSolid(sides), true);
  });
});

describe("quaternions", () => {
  const rng = new SeededSource("quaternions");
  const randomVec = (): Vec3 => [rng.float() * 2 - 1, rng.float() * 2 - 1, rng.float() * 2 - 1];

  test("a rotation is unit length, carries one direction onto another and composes in order", () => {
    for (let i = 0; i < 200; i++) {
      const q = quatFromAxisAngle(randomVec(), rng.float() * 10 - 5);
      assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
    }
    for (let i = 0; i < 300; i++) {
      const a = vNormalize(randomVec());
      const b = vNormalize(randomVec());
      const moved = rotateVec(quatFromTo(a, b), a);
      assert.ok(vDistance(moved, b) < 1e-9, `${a} -> ${b} gave ${moved}`);
    }
    // The two awkward cases: nothing to do, and a half turn about some
    // perpendicular, where a naive cross product gives a zero axis.
    assert.deepEqual(quatFromTo([0, 1, 0], [0, 1, 0]), IDENTITY);
    for (const a of [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0.3, -0.5, 0.81]] as Vec3[]) {
      const unit = vNormalize(a);
      const opposite: Vec3 = [-unit[0], -unit[1], -unit[2]];
      assert.ok(vDistance(rotateVec(quatFromTo(unit, opposite), unit), opposite) < 1e-9, `${unit} did not flip`);
    }
    const x = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const y = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const v: Vec3 = [0, 0, 1];
    assert.ok(vDistance(rotateVec(quatMultiply(x, y), v), rotateVec(x, rotateVec(y, v))) < 1e-9);
  });

  test("slerp reaches both ends, stays unit length, and takes the short way round", () => {
    const a = quatFromAxisAngle([0, 1, 0], 0.3);
    const b = quatFromAxisAngle([0.3, 0.5, 0.81], 2.7);
    assert.ok(vDistance(rotateVec(quatSlerp(a, b, 0), [1, 0, 0]), rotateVec(a, [1, 0, 0])) < 1e-9);
    assert.ok(vDistance(rotateVec(quatSlerp(a, b, 1), [1, 0, 0]), rotateVec(b, [1, 0, 0])) < 1e-9);
    for (let t = 0; t <= 1; t += 0.05) {
      const q = quatSlerp(a, b, t);
      assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9, `not unit at t=${t}`);
    }
    // The same rotation written with a negated quaternion: slerp must not
    // travel the long way to reach an orientation it is already at.
    const mid = quatSlerp(IDENTITY, quatNormalize([-0, -0, -0, -1]), 0.5);
    assert.ok(vDistance(rotateVec(mid, [1, 2, 3]), [1, 2, 3]) < 1e-6);
  });
});

describe("coming to rest", () => {
  test("the rest pose allows for the camera, so the face is square-on as seen", () => {
    // A tilted camera would otherwise leave every landed die skewed.
    const view = quatFromAxisAngle([1, 0, 0], 0.42);
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (let face = 0; face < s.faceNormals.length; face++) {
        assert.ok(facingError(s, restQuaternion(s, face, 0.7, view), view) < 1e-6, `d${sides} face ${face} is skewed`);
        // And without allowing for the camera it would not be.
        assert.ok(facingError(s, restQuaternion(s, face, 0.7), view) > 1, "the correction should matter");
      }
    }
  });

  test("the opening tumble uses two different diagonals of the solid", () => {
    const rng = new SeededSource("axes");
    for (const sides of [...ALL_SOLIDS, 7]) {
      const solid = solidForSides(sides);
      assert.ok(solid.diagonals.length >= 2, `d${sides}: needs at least two axes to tumble about`);
      for (let i = 0; i < 200; i++) {
        const [a, b] = pickTumbleAxes(solid, () => rng.float());
        assert.ok(solid.diagonals.includes(a) && solid.diagonals.includes(b), `d${sides}: not one of its diagonals`);
        assert.notEqual(a, b, `d${sides}: both axes are the same line`);
      }
    }
    // However the random source behaves, including at its very ends.
    const cube = solidForSides(6);
    for (const value of [0, 0.999999, 1, 0.5]) {
      const [a, b] = pickTumbleAxes(cube, () => value);
      assert.notEqual(a, b);
    }
  });
});
