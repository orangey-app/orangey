import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY,
  TOWARDS_VIEWER,
  bounceSchedule,
  computeFaces,
  facingError,
  faceCentroid,
  faceEdgeLength,
  faceVertexIndices,
  hasDedicatedSolid,
  pickTumbleAxes,
  project,
  quatConjugate,
  quatFromAxisAngle,
  quatFromTo,
  quatMultiply,
  quatNormalize,
  quatSlerp,
  restQuaternion,
  rotateVec,
  solidForSides,
  vDistance,
  vDot,
  vLength,
  vNormalize,
  type Vec3,
} from "../../src/core/polyhedra.ts";
import { SeededSource } from "../../src/core/rng.ts";

const PLATONIC = [4, 6, 8, 12, 20];
const ALL_SOLIDS = [4, 6, 8, 10, 12, 20, 100];

describe("solids", () => {
  test("each die gets the expected shape", () => {
    const shape = (sides: number) => {
      const s = solidForSides(sides);
      return [s.vertices.length, s.edges.length, s.faceNormals.length];
    };
    assert.deepEqual(shape(4), [4, 6, 4], "tetrahedron");
    assert.deepEqual(shape(6), [8, 12, 6], "cube");
    assert.deepEqual(shape(8), [6, 12, 8], "octahedron");
    assert.deepEqual(shape(10), [12, 20, 10], "pentagonal trapezohedron");
    assert.deepEqual(shape(12), [20, 30, 12], "dodecahedron");
    assert.deepEqual(shape(20), [12, 30, 20], "icosahedron");
    assert.deepEqual(shape(100), [12, 20, 10], "d100 uses the d10 shape");
  });

  test("every solid satisfies Euler's formula", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      assert.equal(
        s.vertices.length - s.edges.length + s.faceNormals.length,
        2,
        `d${sides}: V - E + F should be 2`,
      );
    }
  });

  test("the Platonic solids have equal edges and vertices on one sphere", () => {
    for (const sides of PLATONIC) {
      const s = solidForSides(sides);
      const lengths = s.edges.map(([a, b]) => vDistance(s.vertices[a], s.vertices[b]));
      const first = lengths[0];
      for (const l of lengths) {
        assert.ok(Math.abs(l - first) < 1e-9, `d${sides}: edge lengths differ (${l} vs ${first})`);
      }
      for (const v of s.vertices) {
        assert.ok(Math.abs(vLength(v) - 1) < 1e-9, `d${sides}: vertex not on the unit sphere`);
      }
    }
  });

  test("no edge is listed twice and every index is real", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      const seen = new Set<string>();
      for (const [a, b] of s.edges) {
        assert.ok(a >= 0 && a < s.vertices.length && b >= 0 && b < s.vertices.length, `d${sides}: bad index`);
        assert.notEqual(a, b, `d${sides}: an edge joins a vertex to itself`);
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        assert.ok(!seen.has(key), `d${sides}: edge ${key} appears twice`);
        seen.add(key);
      }
    }
  });

  test("face normals are unit vectors and all distinct", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (const n of s.faceNormals) {
        assert.ok(Math.abs(vLength(n) - 1) < 1e-9, `d${sides}: normal is not a unit vector`);
      }
      for (let i = 0; i < s.faceNormals.length; i++) {
        for (let j = i + 1; j < s.faceNormals.length; j++) {
          assert.ok(vDot(s.faceNormals[i], s.faceNormals[j]) < 1 - 1e-6, `d${sides}: two faces point the same way`);
        }
      }
    }
  });

  test("tumbling axes are unit vectors and none is a repeat of another", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      assert.ok(s.diagonals.length >= 2, `d${sides}: needs at least two axes to tumble about`);
      for (let i = 0; i < s.diagonals.length; i++) {
        assert.ok(Math.abs(vLength(s.diagonals[i]) - 1) < 1e-9);
        for (let j = i + 1; j < s.diagonals.length; j++) {
          assert.ok(Math.abs(vDot(s.diagonals[i], s.diagonals[j])) < 1 - 1e-6, `d${sides}: two axes are the same line`);
        }
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

  test("solids are built once and reused", () => {
    assert.equal(solidForSides(20), solidForSides(20));
  });
});

describe("quaternions", () => {
  const rng = new SeededSource("quaternions");
  const randomVec = (): Vec3 => [rng.float() * 2 - 1, rng.float() * 2 - 1, rng.float() * 2 - 1];

  test("an axis-angle rotation is a unit quaternion", () => {
    for (let i = 0; i < 200; i++) {
      const q = quatFromAxisAngle(randomVec(), rng.float() * 10 - 5);
      assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9);
    }
  });

  test("rotating about an axis leaves that axis alone", () => {
    for (let i = 0; i < 100; i++) {
      const axis = vNormalize(randomVec());
      const q = quatFromAxisAngle(axis, rng.float() * 6);
      const spun = rotateVec(q, axis);
      assert.ok(vDistance(spun, axis) < 1e-9, `${spun} should still be ${axis}`);
    }
  });

  test("rotation preserves vLength and angles", () => {
    const q = quatFromAxisAngle([1, 2, 3], 1.1);
    const a = vNormalize([1, 0, 0]);
    const b = vNormalize([0, 1, 0]);
    assert.ok(Math.abs(vLength(rotateVec(q, a)) - 1) < 1e-9);
    assert.ok(Math.abs(vDot(rotateVec(q, a), rotateVec(q, b)) - vDot(a, b)) < 1e-9);
  });

  test("a quarter turn about x takes up to forwards", () => {
    const q = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const v = rotateVec(q, [0, 1, 0]);
    assert.ok(vDistance(v, [0, 0, 1]) < 1e-9, `got ${v}`);
  });

  test("quatFromTo maps one direction onto another, including the awkward cases", () => {
    for (let i = 0; i < 300; i++) {
      const a = vNormalize(randomVec());
      const b = vNormalize(randomVec());
      const moved = rotateVec(quatFromTo(a, b), a);
      assert.ok(vDistance(moved, b) < 1e-9, `${a} -> ${b} gave ${moved}`);
    }
    // Identical directions: nothing to do.
    assert.deepEqual(quatFromTo([0, 1, 0], [0, 1, 0]), IDENTITY);
    // Opposite directions: a half turn about something perpendicular.
    for (const a of [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0.3, -0.5, 0.81]] as Vec3[]) {
      const unit = vNormalize(a);
      const flipped = rotateVec(quatFromTo(unit, [-unit[0], -unit[1], -unit[2]]), unit);
      assert.ok(vDistance(flipped, [-unit[0], -unit[1], -unit[2]]) < 1e-9, `${unit} did not flip`);
    }
  });

  test("multiplication composes rotations in order", () => {
    const a = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const b = quatFromAxisAngle([1, 0, 0], Math.PI / 2);
    const composed = quatMultiply(a, b);
    const v: Vec3 = [0, 0, 1];
    assert.ok(vDistance(rotateVec(composed, v), rotateVec(a, rotateVec(b, v))) < 1e-9);
  });

  test("slerp hits both ends and stays on the unit sphere", () => {
    const a = quatFromAxisAngle([0, 1, 0], 0.3);
    const b = quatFromAxisAngle([0.3, 0.5, 0.81], 2.7);
    assert.ok(vDistance(rotateVec(quatSlerp(a, b, 0), [1, 0, 0]), rotateVec(a, [1, 0, 0])) < 1e-9);
    assert.ok(vDistance(rotateVec(quatSlerp(a, b, 1), [1, 0, 0]), rotateVec(b, [1, 0, 0])) < 1e-9);
    for (let t = 0; t <= 1; t += 0.05) {
      const q = quatSlerp(a, b, t);
      assert.ok(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-9, `not unit at t=${t}`);
    }
  });

  test("slerp takes the short way round", () => {
    const a = IDENTITY;
    // The same rotation written with a negated quaternion: slerp must not
    // travel the long way to reach an orientation it is already at.
    const b = quatNormalize([-0, -0, -0, -1]);
    const mid = quatSlerp(a, b, 0.5);
    assert.ok(vDistance(rotateVec(mid, [1, 2, 3]), [1, 2, 3]) < 1e-6);
  });
});

describe("tumbling", () => {
  test("the opening tumble uses two different diagonals of the solid", () => {
    const rng = new SeededSource("axes");
    for (const sides of [...ALL_SOLIDS, 7]) {
      const solid = solidForSides(sides);
      for (let i = 0; i < 200; i++) {
        const [a, b] = pickTumbleAxes(solid, () => rng.float());
        assert.ok(solid.diagonals.includes(a), `d${sides}: first axis is not one of the solid's diagonals`);
        assert.ok(solid.diagonals.includes(b), `d${sides}: second axis is not one of the solid's diagonals`);
        assert.notEqual(a, b, `d${sides}: both axes are the same line`);
      }
    }
  });

  test("axis choice terminates however the random source behaves", () => {
    const solid = solidForSides(6);
    for (const value of [0, 0.999999, 1, 0.5]) {
      const [a, b] = pickTumbleAxes(solid, () => value);
      assert.notEqual(a, b);
      assert.ok(solid.diagonals.includes(a) && solid.diagonals.includes(b));
    }
  });

  test("every solid offers enough axes for two to be picked", () => {
    for (const sides of [...ALL_SOLIDS, 3, 7, 30]) {
      assert.ok(solidForSides(sides).diagonals.length >= 2, `d${sides}`);
    }
  });

  test("the bounces are evenly spaced and the last one starts the settle", () => {
    for (const bounces of [1, 2, 3, 4]) {
      const s = bounceSchedule(1200, bounces);
      assert.equal(s.bounceAt.length, bounces);
      for (let i = 1; i < s.bounceAt.length; i++) {
        assert.ok(s.bounceAt[i] > s.bounceAt[i - 1], "bounces must move forwards");
      }
      assert.ok(s.bounceAt[0] > 0 && s.bounceAt[bounces - 1] < 1200);
      assert.equal(s.settleStart, s.bounceAt[bounces - 1], "the settle begins at the last bounce");
      assert.equal(s.settleEnd, 1200);
      const gaps = s.bounceAt.map((t, i) => t - (i === 0 ? 0 : s.bounceAt[i - 1]));
      for (const gap of gaps) assert.ok(Math.abs(gap - gaps[0]) < 1e-9, "bounces should be evenly spaced");
    }
  });

  test("with no bounces the die still spends its last stretch settling", () => {
    const s = bounceSchedule(1000, 0);
    assert.deepEqual(s.bounceAt, []);
    assert.equal(s.settleStart, 600);
    assert.equal(s.settleEnd, 1000);
    assert.ok(s.settleStart < s.settleEnd, "there must be time to settle in");
  });
});

describe("coming to rest", () => {
  test("the rest pose turns the chosen face exactly square-on to the viewer", () => {
    const rng = new SeededSource("rest");
    for (const sides of [...ALL_SOLIDS, 7]) {
      const s = solidForSides(sides);
      for (let face = 0; face < s.faceNormals.length; face++) {
        const q = restQuaternion(s, face, rng.float() * Math.PI * 2);
        const towards = rotateVec(q, s.faceNormals[face]);
        assert.ok(vDistance(towards, TOWARDS_VIEWER) < 1e-9, `d${sides} face ${face} rested at ${towards}`);
        assert.ok(facingError(s, q) < 1e-6, `d${sides} face ${face} is not square-on`);
      }
    }
  });

  test("the rest pose allows for the camera, so the face is square-on as seen", () => {
    // A tilted camera would otherwise leave every landed die skewed.
    const view = quatFromAxisAngle([1, 0, 0], 0.42);
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (let face = 0; face < s.faceNormals.length; face++) {
        const q = restQuaternion(s, face, 0.7, view);
        assert.ok(facingError(s, q, view) < 1e-6, `d${sides} face ${face} is skewed under the camera tilt`);
        // And without allowing for the camera it would not be.
        assert.ok(facingError(s, restQuaternion(s, face, 0.7), view) > 1, "the correction should matter");
      }
    }
  });

  test("the spin turns the die in the plane of the face without lifting it", () => {
    const s = solidForSides(6);
    const a = restQuaternion(s, 0, 0);
    const b = restQuaternion(s, 0, 1.3);
    assert.ok(facingError(s, b) < 1e-6, "still square-on");
    assert.ok(vDistance(rotateVec(a, s.vertices[0]), rotateVec(b, s.vertices[0])) > 0.1, "the spin should show");
  });

  test("face indices wrap, so any rolled value has a face to land on", () => {
    const s = solidForSides(6);
    for (const face of [0, 5, 6, 99, -1]) {
      assert.ok(facingError(s, restQuaternion(s, face)) < 1e-6, `face ${face}`);
    }
  });

  test("a tumbling orientation is not square-on", () => {
    const s = solidForSides(6);
    const tilted = quatMultiply(quatFromAxisAngle([1, 1, 1], 0.6), restQuaternion(s, 0));
    assert.ok(facingError(s, tilted) > 5, `only ${facingError(s, tilted)} degrees off`);
  });

  test("conjugating the camera really does undo it", () => {
    const view = quatFromAxisAngle([0.3, 1, 0.2], 0.9);
    const undone = quatNormalize(quatMultiply(view, quatConjugate(view)));
    assert.ok(vDistance(rotateVec(undone, [1, 2, 3]), [1, 2, 3]) < 1e-9);
  });
});

describe("faces", () => {
  test("every face has the number of sides that solid's faces have", () => {
    const expected: Record<number, number> = { 4: 3, 6: 4, 8: 3, 10: 4, 12: 5, 20: 3, 100: 4 };
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (const face of s.faces) {
        assert.equal(face.length, expected[sides], `d${sides}: a face with ${face.length} sides`);
      }
    }
  });

  test("there is one face per normal, and every vertex belongs to some face", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      assert.equal(s.faces.length, s.faceNormals.length);
      const used = new Set(s.faces.flat());
      assert.equal(used.size, s.vertices.length, `d${sides}: some vertex is on no face`);
    }
  });

  test("a face's vertices all lie on its plane, and every other vertex is behind it", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      s.faces.forEach((face, i) => {
        const normal = s.faceNormals[i];
        const offset = vDot(s.vertices[face[0]], normal);
        for (const v of face) {
          assert.ok(Math.abs(vDot(s.vertices[v], normal) - offset) < 1e-6, `d${sides} face ${i} is not planar`);
        }
        for (let v = 0; v < s.vertices.length; v++) {
          assert.ok(vDot(s.vertices[v], normal) <= offset + 1e-6, `d${sides} face ${i} is not a supporting plane`);
        }
      });
    }
  });

  test("faceVertexIndices agrees with the derived face list", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (let i = 0; i < s.faces.length; i++) {
        assert.deepEqual([...faceVertexIndices(s, i)].sort((a, b) => a - b), [...s.faces[i]].sort((a, b) => a - b));
      }
    }
  });

  test("the face centroid sits on the face, along its normal", () => {
    for (const sides of ALL_SOLIDS) {
      const s = solidForSides(sides);
      for (let i = 0; i < s.faces.length; i++) {
        const centre = faceCentroid(s, i);
        const offset = vDot(s.vertices[s.faces[i][0]], s.faceNormals[i]);
        assert.ok(Math.abs(vDot(centre, s.faceNormals[i]) - offset) < 1e-9, `d${sides} face ${i}`);
        assert.ok(vLength(centre) < 1.0001);
      }
    }
  });

  test("a regular face has one side length, and the kite has two", () => {
    for (const sides of [4, 6, 8, 12, 20]) {
      const s = solidForSides(sides);
      const first = faceEdgeLength(s, 0);
      assert.ok(first > 0);
      for (let i = 1; i < s.faces.length; i++) {
        assert.ok(Math.abs(faceEdgeLength(s, i) - first) < 1e-9, `d${sides}: faces differ in size`);
      }
    }
    // The trapezohedron's faces are kites: two short sides and two long ones,
    // which is why the number is sized from the mean rather than the shortest.
    const ten = solidForSides(10);
    const face = ten.faces[0];
    const lengths: number[] = [];
    for (let i = 0; i < face.length; i++) {
      for (let j = i + 1; j < face.length; j++) {
        lengths.push(vDistance(ten.vertices[face[i]], ten.vertices[face[j]]));
      }
    }
    assert.ok(new Set(lengths.map((l) => l.toFixed(4))).size > 1, "a kite should not be equilateral");
  });

  test("computeFaces finds the faces of a cube from nothing but its vertices and edges", () => {
    const cube = solidForSides(6);
    const { faces, normals } = computeFaces(cube.vertices, cube.edges);
    assert.equal(faces.length, 6);
    assert.equal(normals.length, 6);
    for (const face of faces) assert.equal(face.length, 4);
    // Six normals, all axis-aligned, three opposite pairs.
    for (const n of normals) {
      const axes = n.map((c) => Math.abs(Math.abs(c) - 1) < 1e-9);
      assert.equal(axes.filter(Boolean).length, 1, `${n} is not an axis direction`);
    }
  });
});

describe("projection", () => {
  test("the centre of the solid projects to the centre of the view", () => {
    const p = project([0, 0, 0], 20);
    assert.equal(p.x, 0);
    assert.equal(p.y, 0);
  });

  test("screen y is flipped, because canvases count downwards", () => {
    assert.ok(project([0, 1, 0], 20).y < 0);
    assert.ok(project([0, -1, 0], 20).y > 0);
  });

  test("nearer points project larger", () => {
    const near = project([1, 0, 0.9], 20);
    const far = project([1, 0, -0.9], 20);
    assert.ok(near.x > far.x, `${near.x} should exceed ${far.x}`);
    assert.ok(near.z > far.z);
  });

  test("radius scales the projection", () => {
    assert.ok(Math.abs(project([1, 0, 0], 40).x - 2 * project([1, 0, 0], 20).x) < 1e-9);
  });
});
