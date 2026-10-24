// Floor planes from ARKit → the `RoomScan` the phone sends (shared/protocol.ts). Pure math: the app
// hands in each detected floor / ceiling plane in ARKit world coordinates; this finds the floor
// height, the outline of the floor seen so far (convex hull, simplified), the ceiling, and maps
// everything into the pose `offset` frame with the tracker's Recentre map, so the laptop can draw
// the real room at anchor + point, exactly where the phone walks.
//
// The outline is convex: an L-shaped room comes out as its hull. Good enough to keep the
// director's blocking inside the real room and to warn near walls; not a floor plan.
import simd

public struct DetectedPlane: Sendable, Equatable {
  public enum Kind: Sendable { case floor, ceiling, otherHorizontal }
  public var kind: Kind
  /// Boundary vertices in ARKit world coordinates (metres).
  public var boundary: [SIMD3<Double>]

  public init(kind: Kind, boundary: [SIMD3<Double>]) {
    self.kind = kind
    self.boundary = boundary
  }
}

public struct RoomFootprint: Sendable, Equatable {
  /// Outline [x, z] in ARKit world, counter-clockwise (+x right, +z towards the viewer).
  public var outline: [SIMD2<Double>]
  /// Floor height, ARKit world y.
  public var floorY: Double
  /// Floor to ceiling, when a ceiling was seen.
  public var ceiling: Double?

  public var area: Double { abs(RoomFootprint.signedArea(outline)) }

  /// nil until at least `minArea` m² of floor has been seen.
  public static func from(_ planes: [DetectedPlane], maxPoints: Int = 32, minArea: Double = 1)
    -> RoomFootprint?
  {
    var floors = planes.filter { $0.kind == .floor && !$0.boundary.isEmpty }
    if floors.isEmpty {
      // No classification (older phones): the lowest horizontal planes are the floor.
      let horizontal = planes.filter { $0.kind != .ceiling && !$0.boundary.isEmpty }
      guard let lowest = horizontal.map(meanY).min() else { return nil }
      floors = horizontal.filter { meanY($0) < lowest + 0.1 }
    }
    let floorY = median(floors.map(meanY))
    let points = floors.flatMap { $0.boundary.map { SIMD2($0.x, $0.z) } }
    var hull = convexHull(points)
    guard hull.count >= 3, abs(signedArea(hull)) >= minArea else { return nil }
    hull = simplify(hull, maxPoints: maxPoints)
    let ceilings = planes.filter { $0.kind == .ceiling && !$0.boundary.isEmpty }.map(meanY)
    let ceiling = ceilings.isEmpty ? nil : median(ceilings) - floorY
    return RoomFootprint(outline: hull, floorY: floorY, ceiling: ceiling.flatMap { $0 > 1.5 ? $0 : nil })
  }

  /// The wire message: outline and floor in the pose `offset` frame (`toScene` is
  /// `PoseTracker.toScene`), rounded to the millimetre.
  public func message(source: RoomScan.Source, toScene: (SIMD3<Double>) -> SIMD3<Double>) -> RoomScan {
    var pts = outline.map { p -> [Double] in
      let s = toScene(SIMD3(p.x, floorY, p.y))
      return [Wire.round(s.x, 1e3), Wire.round(s.z, 1e3)]
    }
    // The Recentre yaw is a rotation, so the winding is kept; enforce it anyway.
    if RoomFootprint.signedArea(pts.map { SIMD2($0[0], $0[1]) }) < 0 { pts.reverse() }
    let floor = toScene(SIMD3(0, floorY, 0)).y
    return RoomScan(
      source: source, outline: pts, floorY: Wire.round(floor, 1e3),
      ceiling: ceiling.map { Wire.round($0, 1e3) }, area: Wire.round(area, 1e2))
  }

  // MARK: - Geometry

  static func meanY(_ p: DetectedPlane) -> Double {
    p.boundary.reduce(0) { $0 + $1.y } / Double(p.boundary.count)
  }

  static func median(_ v: [Double]) -> Double {
    let s = v.sorted()
    return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
  }

  /// Shoelace, positive when counter-clockwise in (x, z).
  public static func signedArea(_ poly: [SIMD2<Double>]) -> Double {
    guard poly.count >= 3 else { return 0 }
    var a = 0.0
    for i in poly.indices {
      let p = poly[i], q = poly[(i + 1) % poly.count]
      a += p.x * q.y - q.x * p.y
    }
    return a / 2
  }

  /// Andrew's monotone chain, counter-clockwise, collinear points dropped.
  public static func convexHull(_ points: [SIMD2<Double>]) -> [SIMD2<Double>] {
    let pts = points.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
    guard pts.count >= 3 else { return pts }
    func cross(_ o: SIMD2<Double>, _ a: SIMD2<Double>, _ b: SIMD2<Double>) -> Double {
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    }
    var lower: [SIMD2<Double>] = []
    for p in pts {
      while lower.count >= 2, cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 { lower.removeLast() }
      lower.append(p)
    }
    var upper: [SIMD2<Double>] = []
    for p in pts.reversed() {
      while upper.count >= 2, cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 { upper.removeLast() }
      upper.append(p)
    }
    return Array(lower.dropLast() + upper.dropLast())
  }

  /// Visvalingam: drop the vertex whose triangle with its neighbours is smallest until ≤ maxPoints.
  public static func simplify(_ poly: [SIMD2<Double>], maxPoints: Int) -> [SIMD2<Double>] {
    var p = poly
    func weight(_ i: Int) -> Double {
      let a = p[(i + p.count - 1) % p.count], b = p[i], c = p[(i + 1) % p.count]
      return abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
    }
    while p.count > max(3, maxPoints) {
      let i = p.indices.min { weight($0) < weight($1) }!
      p.remove(at: i)
    }
    return p
  }
}
