/**
 * Polyhedra and orientation maths for the wireframe dice.
 *
 * The drawing technique is the one the Rosetta Code "Draw a rotating cube"
 * task demonstrates: keep the solid as a list of vertices and a list of edges,
 * rotate the vertices, project them, draw the edges. What is added here is the
 * part a die needs and a spinning cube does not — the axes a real die tumbles
 * about, and an orientation it can come to rest in with a face lying flat.
 *
 * Orientation is a unit quaternion rather than a pair of accumulated Euler
 * angles. The dice change axis mid-flight and then have to settle onto an
 * exact resting pose; Euler angles gimbal-lock and drift under that, and
 * cannot be interpolated into a target pose cleanly.
 *
 * Coordinates are right-handed with +y up. The projection flips y, because
 * screens count downwards.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number]; // x, y, z, w
export type Edge = readonly [number, number];

export interface Solid {
  /** The die this is the shape of, e.g. "d20". */
  name: string;
  vertices: Vec3[];
  edges: Edge[];
  /** Vertex indices making up each face, in no particular winding. */
  faces: number[][];
  /** Outward unit normal per face; the rest pose turns one of these to face
   *  the viewer. */
  faceNormals: Vec3[];
  /** Axes the solid tumbles about: through opposite vertices where it has
   *  them, vertex to opposite face otherwise. */
  diagonals: Vec3[];
}

/* -------------------------------------------------------------------------- */
/* vectors                                                                     */
/* -------------------------------------------------------------------------- */

export const vAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vScale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const vDot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vCross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vLength = (a: Vec3): number => Math.sqrt(vDot(a, a));

export function vNormalize(a: Vec3): Vec3 {
  const l = vLength(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export function vDistance(a: Vec3, b: Vec3): number {
  return vLength(vSub(a, b));
}

/* -------------------------------------------------------------------------- */
/* quaternions                                                                 */
/* -------------------------------------------------------------------------- */

export const IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const [x, y, z] = vNormalize(axis);
  const half = radians / 2;
  const s = Math.sin(half);
  return [x * s, y * s, z * s, Math.cos(half)];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l === 0 ? IDENTITY : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotate a vector by a unit quaternion. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q.xyz × v); v' = v + w*t + q.xyz × t
  const t = vScale(vCross([x, y, z], v), 2);
  return vAdd(vAdd(v, vScale(t, w)), vCross([x, y, z], t));
}

/** Shortest-arc rotation taking direction `from` onto direction `to`. */
export function quatFromTo(from: Vec3, to: Vec3): Quat {
  const a = vNormalize(from);
  const b = vNormalize(to);
  const d = vDot(a, b);
  if (d >= 1 - 1e-9) return IDENTITY;
  if (d <= -1 + 1e-9) {
    // Opposite directions: any perpendicular axis will do, half a turn about it.
    const axis = Math.abs(a[0]) < 0.9 ? vCross(a, [1, 0, 0]) : vCross(a, [0, 1, 0]);
    return quatFromAxisAngle(vNormalize(axis), Math.PI);
  }
  const axis = vCross(a, b);
  return quatNormalize([axis[0], axis[1], axis[2], 1 + d]);
}

/** Spherical interpolation, taking the shorter of the two arcs. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    d = -d;
  }
  if (d > 0.9995) {
    return quatNormalize([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const theta = Math.acos(d);
  const sin = Math.sin(theta);
  const ka = Math.sin((1 - t) * theta) / sin;
  const kb = Math.sin(t * theta) / sin;
  return quatNormalize([a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb]);
}

/* -------------------------------------------------------------------------- */
/* solids                                                                      */
/* -------------------------------------------------------------------------- */

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * Find the faces of a convex solid from its vertices and edges.
 *
 * For every corner — an edge (a, b) plus a further neighbour c of b — take the
 * plane through those three vertices. It is a face exactly when every vertex
 * of the solid lies on it or behind it. The vertices on that plane are the
 * face, and its outward normal is the plane's.
 *
 * Deriving the faces beats listing them: a typed-out face list is a second
 * description of the same shape, and the two drift apart. This one cannot
 * disagree with the vertices, and it caught a wrong dodecahedron the first
 * time it ran.
 */
export function computeFaces(vertices: Vec3[], edges: Edge[], tolerance = 1e-6): { faces: number[][]; normals: Vec3[] } {
  const adjacency: number[][] = vertices.map(() => []);
  for (const [a, b] of edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  const faces: number[][] = [];
  const normals: Vec3[] = [];
  const seen = new Set<string>();

  for (const [a, b] of edges) {
    for (const c of adjacency[b]) {
      if (c === a) continue;
      let normal = vNormalize(vCross(vSub(vertices[b], vertices[a]), vSub(vertices[c], vertices[a])));
      if (vLength(normal) < 0.5) continue; // the three are collinear
      let offset = vDot(vertices[a], normal);
      if (offset < 0) {
        normal = vScale(normal, -1);
        offset = -offset;
      }
      if (offset < tolerance) continue; // the plane passes through the centre

      // Round first, then flatten a negative zero: a component of -1e-17
      // prints as "-0.000000" while a component of +1e-17 prints as
      // "0.000000", which would file one face under two keys and report a
      // ten-sider with eleven faces.
      const key = normal
        .map((n) => {
          const rounded = Number(n.toFixed(6));
          return (rounded === 0 ? 0 : rounded).toFixed(6);
        })
        .join(",");
      if (seen.has(key)) continue;

      const on: number[] = [];
      let supporting = true;
      for (let i = 0; i < vertices.length; i++) {
        const d = vDot(vertices[i], normal);
        if (d > offset + tolerance) {
          supporting = false;
          break;
        }
        if (d > offset - tolerance) on.push(i);
      }
      if (!supporting || on.length < 3) continue;

      seen.add(key);
      faces.push(on);
      normals.push(normal);
    }
  }
  return { faces, normals };
}

/** Attach the derived faces to a solid built from vertices and edges. */
function withFaces(partial: Omit<Solid, "faces" | "faceNormals">): Solid {
  const { faces, normals } = computeFaces(partial.vertices, partial.edges);
  return { ...partial, faces, faceNormals: normals };
}

/**
 * Edges of a solid whose faces are all alike: every pair of vertices at the
 * shortest vertex-to-vertex vDistance. Cheaper to get right than typing out
 * thirty index pairs, and it cannot disagree with the vertex list.
 */
function edgesByShortestDistance(vertices: Vec3[], tolerance = 1e-6): Edge[] {
  let shortest = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const d = vDistance(vertices[i], vertices[j]);
      if (d < shortest) shortest = d;
    }
  }
  const edges: Edge[] = [];
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      if (Math.abs(vDistance(vertices[i], vertices[j]) - shortest) < tolerance * Math.max(1, shortest)) {
        edges.push([i, j]);
      }
    }
  }
  return edges;
}

/** Unique axes through pairs of opposite vertices. */
function diagonalsFromOppositeVertices(vertices: Vec3[]): Vec3[] {
  const axes: Vec3[] = [];
  for (const v of vertices) {
    const axis = vNormalize(v);
    if (!axes.some((a) => Math.abs(Math.abs(vDot(a, axis)) - 1) < 1e-6)) axes.push(axis);
  }
  return axes;
}

function scaleToUnit(vertices: Vec3[]): Vec3[] {
  const longest = Math.max(...vertices.map(vLength));
  return vertices.map((v) => vScale(v, 1 / longest));
}

function tetrahedron(): Solid {
  const vertices = scaleToUnit([
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ]);
  return withFaces({
    name: "d4",
    vertices,
    edges: edgesByShortestDistance(vertices),
    // It has no opposite vertices, so its axes run vertex to opposite face.
    diagonals: vertices.map(vNormalize),
  });
}

function cube(): Solid {
  const vertices: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push([x, y, z]);
  const scaled = scaleToUnit(vertices);
  return withFaces({
    name: "d6",
    vertices: scaled,
    edges: edgesByShortestDistance(scaled),
    diagonals: diagonalsFromOppositeVertices(scaled),
  });
}

function octahedron(): Solid {
  const vertices: Vec3[] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  return withFaces({
    name: "d8",
    vertices,
    edges: edgesByShortestDistance(vertices),
    diagonals: diagonalsFromOppositeVertices(vertices),
  });
}

function icosahedronVertices(): Vec3[] {
  const v: Vec3[] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      v.push([0, s1 * 1, s2 * PHI]);
      v.push([s1 * 1, s2 * PHI, 0]);
      v.push([s1 * PHI, 0, s2 * 1]);
    }
  }
  return scaleToUnit(v);
}

function dodecahedronVertices(): Vec3[] {
  const v: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      v.push([0, s1 / PHI, s2 * PHI]);
      v.push([s1 / PHI, s2 * PHI, 0]);
      v.push([s1 * PHI, 0, s2 / PHI]);
    }
  }
  return scaleToUnit(v);
}

function dodecahedron(): Solid {
  const vertices = dodecahedronVertices();
  return withFaces({
    name: "d12",
    vertices,
    edges: edgesByShortestDistance(vertices),
    diagonals: diagonalsFromOppositeVertices(vertices),
  });
}

function icosahedron(): Solid {
  const vertices = icosahedronVertices();
  return withFaces({
    name: "d20",
    vertices,
    edges: edgesByShortestDistance(vertices),
    diagonals: diagonalsFromOppositeVertices(vertices),
  });
}

/** Newell's method: a normal that is right for any planar polygon. */
function polygonNormal(points: Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n = vAdd(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  return vNormalize(n);
}

/**
 * The pentagonal trapezohedron: ten kite faces, which is the shape of a real
 * ten-sider. Not Platonic, but using a d10-shaped d10 matters more than
 * keeping the family tidy.
 *
 * The two staggered rings sit at a height that makes each kite genuinely
 * planar. That height is solved for rather than guessed: with the wrong one
 * the "faces" are creased, and nothing downstream — the face finder, the
 * resting pose, the number written on the face — has a plane to work with.
 */
function trapezohedronRingHeight(): number {
  const angle = (deg: number) => (deg * Math.PI) / 180;
  // Coplanarity of the kite (top apex, upper k, lower k, upper k+1).
  const offPlane = (c: number): number => {
    const apex: Vec3 = [0, 1, 0];
    const u0: Vec3 = [1, c, 0];
    const u1: Vec3 = [Math.cos(angle(72)), c, Math.sin(angle(72))];
    const l0: Vec3 = [Math.cos(angle(36)), -c, Math.sin(angle(36))];
    const normal = vCross(vSub(u0, apex), vSub(u1, apex));
    return vDot(vSub(l0, apex), normal);
  };
  let low = 0.01;
  let high = 0.9;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (Math.sign(offPlane(mid)) === Math.sign(offPlane(low))) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function trapezohedron(name: string): Solid {
  const ringY = trapezohedronRingHeight();
  const vertices: Vec3[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k * 2 * Math.PI) / 5;
    vertices.push([Math.cos(a), ringY, Math.sin(a)]);
  }
  for (let k = 0; k < 5; k++) {
    const a = ((k + 0.5) * 2 * Math.PI) / 5;
    vertices.push([Math.cos(a), -ringY, Math.sin(a)]);
  }
  const top = vertices.push([0, 1, 0]) - 1;
  const bottom = vertices.push([0, -1, 0]) - 1;

  const upper = (k: number) => k % 5;
  const lower = (k: number) => 5 + (k % 5);

  const edges: Edge[] = [];
  for (let k = 0; k < 5; k++) {
    edges.push([top, upper(k)]);
    edges.push([bottom, lower(k)]);
    edges.push([upper(k), lower(k)]);
    edges.push([lower(k), upper(k + 1)]);
  }

  const scaled = scaleToUnit(vertices);
  return withFaces({
    name,
    vertices: scaled,
    edges,
    // The apex-to-apex axis plus the five vertex-to-opposite-vertex axes.
    diagonals: [vNormalize([0, 1, 0]), ...Array.from({ length: 5 }, (_, k) => vNormalize(scaled[upper(k)]))],
  });
}

const CACHE = new Map<number, Solid>();

/** The solid to draw for a die of this many sides. */
export function solidForSides(sides: number): Solid {
  const cached = CACHE.get(sides);
  if (cached) return cached;
  let solid: Solid;
  switch (sides) {
    case 4: solid = tetrahedron(); break;
    case 6: solid = cube(); break;
    case 8: solid = octahedron(); break;
    case 10: solid = trapezohedron("d10"); break;
    case 12: solid = dodecahedron(); break;
    case 20: solid = icosahedron(); break;
    case 100: solid = trapezohedron("d100"); break;
    // Anything without a solid of its own tumbles as a cube. It is a stand-in,
    // not a claim about the die's real shape — nothing is drawn on the faces,
    // so what the viewer sees is a die tumbling and landing, which is true.
    default: solid = { ...cube(), name: `d${sides}` }; break;
  }
  CACHE.set(sides, solid);
  return solid;
}

/** True when this die has a solid of its own rather than the fallback. */
export function hasDedicatedSolid(sides: number): boolean {
  return [4, 6, 8, 10, 12, 20, 100].includes(sides);
}

/* -------------------------------------------------------------------------- */
/* landing                                                                     */
/* -------------------------------------------------------------------------- */

export const UP: Vec3 = [0, 1, 0];
/** Towards the viewer. A die at rest turns a face this way to be read. */
export const TOWARDS_VIEWER: Vec3 = [0, 0, 1];

/**
 * The vertices lying on a given face: on a convex solid they are exactly the
 * ones furthest along that face's normal. Derived rather than listed, so a
 * face list can never drift out of step with the vertices.
 */
export function faceVertexIndices(solid: Solid, faceIndex: number, tolerance = 1e-6): number[] {
  const normal = solid.faceNormals[wrapFace(solid, faceIndex)];
  let furthest = -Infinity;
  for (const v of solid.vertices) furthest = Math.max(furthest, vDot(v, normal));
  const indices: number[] = [];
  for (let i = 0; i < solid.vertices.length; i++) {
    if (Math.abs(vDot(solid.vertices[i], normal) - furthest) < tolerance) indices.push(i);
  }
  return indices;
}

function wrapFace(solid: Solid, faceIndex: number): number {
  const n = solid.faceNormals.length;
  return ((faceIndex % n) + n) % n;
}

/** The middle of a face, which is where its number is written. */
export function faceCentroid(solid: Solid, faceIndex: number): Vec3 {
  const indices = faceVertexIndices(solid, faceIndex);
  let sum: Vec3 = [0, 0, 0];
  for (const i of indices) sum = vAdd(sum, solid.vertices[i]);
  return vScale(sum, 1 / Math.max(1, indices.length));
}

/**
 * The length of one side of a face — the shortest distance between two of its
 * vertices. The number written on the face is sized as a fraction of this.
 */
export function faceEdgeLength(solid: Solid, faceIndex: number): number {
  const indices = faceVertexIndices(solid, faceIndex);
  let shortest = Infinity;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      shortest = Math.min(shortest, vDistance(solid.vertices[indices[i]], solid.vertices[indices[j]]));
    }
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

/**
 * The orientation a die comes to rest in: the face it is showing turned
 * square-on to the viewer, so the polygon is seen undistorted and its number
 * can sit centred inside it. `spin` turns it in its own plane, so two dice
 * showing the same number do not land identically.
 *
 * `view` is the camera's own rotation. The die is placed so that *after* the
 * camera transform the face is exactly head-on; without this the tilt that
 * gives the tumble its depth would leave every landed die slightly skewed.
 */
export function restQuaternion(solid: Solid, faceIndex: number, spin = 0, view: Quat = IDENTITY): Quat {
  const normal = solid.faceNormals[wrapFace(solid, faceIndex)];
  const headOn = quatMultiply(quatFromAxisAngle(TOWARDS_VIEWER, spin), quatFromTo(normal, TOWARDS_VIEWER));
  return quatNormalize(quatMultiply(quatConjugate(view), headOn));
}

/**
 * How far, in degrees, this orientation is from showing a face square-on.
 *
 * The angle comes from atan2 of the cross and dot products rather than from
 * acos of the dot alone: acos loses most of its precision exactly where this
 * function is asked the important question — near zero — and would report a
 * die that is perfectly square-on as being a thousandth of a degree off.
 */
export function facingError(solid: Solid, q: Quat, view: Quat = IDENTITY): number {
  const seen = quatMultiply(view, q);
  let best = Math.PI;
  for (const normal of solid.faceNormals) {
    const towards = rotateVec(seen, normal);
    const angle = Math.atan2(vLength(vCross(towards, TOWARDS_VIEWER)), vDot(towards, TOWARDS_VIEWER));
    if (angle < best) best = angle;
  }
  return (best * 180) / Math.PI;
}

/* -------------------------------------------------------------------------- */
/* tumbling                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Two different diagonals of the solid, which is what the die spins about
 * before its first bounce. Two axes at once, rather than one, is what stops
 * the tumble reading as a single mechanical spin.
 */
export function pickTumbleAxes(solid: Solid, random: () => number = Math.random): [Vec3, Vec3] {
  const count = solid.diagonals.length;
  const first = Math.min(count - 1, Math.floor(random() * count));
  let second = first;
  if (count > 1) {
    // Step forward by a non-zero amount rather than resampling, so this
    // terminates however the random source behaves.
    second = (first + 1 + Math.min(count - 2, Math.floor(random() * (count - 1)))) % count;
  }
  return [solid.diagonals[first], solid.diagonals[second]];
}

export interface TumbleSchedule {
  /** Times, in ms from the start of the tumble, at which an axis changes. */
  bounceAt: number[];
  /** When the die begins settling onto its resting face — the last bounce. */
  settleStart: number;
  /** When it is fully at rest. */
  settleEnd: number;
}

/**
 * When the bounces happen. The last bounce is where the settle begins, so the
 * die comes to rest flat rather than stopping mid-tumble; with no bounces at
 * all it simply spends its last two fifths settling.
 */
export function bounceSchedule(durationMs: number, bounces: number): TumbleSchedule {
  const count = Math.max(0, Math.round(bounces));
  const segments = count + 1;
  const bounceAt = Array.from({ length: count }, (_, k) => (durationMs * (k + 1)) / segments);
  return {
    bounceAt,
    settleStart: count > 0 ? bounceAt[count - 1] : durationMs * 0.6,
    settleEnd: durationMs,
  };
}

/* -------------------------------------------------------------------------- */
/* projection                                                                  */
/* -------------------------------------------------------------------------- */

export interface Projected {
  x: number;
  y: number;
  /** Depth after rotation; larger is nearer the viewer. */
  z: number;
}

/**
 * Perspective projection, as in the Rosetta Code variants that use a focal
 * vLength. Screen y is flipped because canvas counts downwards.
 */
export function project(v: Vec3, radius: number, distanceFromCamera = 4): Projected {
  const z = v[2];
  const k = (distanceFromCamera / (distanceFromCamera - z)) * radius;
  // The + 0 turns a negative zero back into zero; it is invisible on screen
  // but it makes the projection compare equal to itself in tests.
  return { x: v[0] * k + 0, y: -v[1] * k + 0, z };
}
