"""App mark candidates. Each mark is a list of strokes; a stroke is a start point plus cubic segments, on a 24x24 grid.
Writes mark-<name>.svg (1024 tile) and prints the 24px path data, recentred so the stroke's box is centred at (12, 12).
Regenerate: python3 mkicon.py twin && mv mark-twin.svg icon.svg && inkscape icon.svg -o icon.png -w 1024
The printed 24px paths go in ICON.logo (renderer.js) and the .mark svg (index.html)."""
import math, sys

K = 0.5523  # cubic approximation of a quarter circle

def arc(cx, cy, r, a0, a1, ry=None):
    """Circular/elliptic arc from angle a0 to a1 (degrees, screen coords: 0=right, 90=down) as cubic segments."""
    ry = ry or r; n = max(1, math.ceil(abs(a1 - a0) / 90)); da = math.radians(a1 - a0) / n
    t = 4 / 3 * math.tan(da / 4); pt = lambda a: (cx + r * math.cos(a), cy + ry * math.sin(a))
    a = math.radians(a0); start = pt(a); segs = []
    for _ in range(n):
        b = a + da; p0, p3 = pt(a), pt(b)
        c1 = (p0[0] - t * r * math.sin(a), p0[1] + t * ry * math.cos(a))
        c2 = (p3[0] + t * r * math.sin(b), p3[1] - t * ry * math.cos(b))
        segs.append((c1, c2, p3)); a = b
    return start, segs

def bez(p0, c1, c2, p3, t):
    u = 1 - t
    return tuple(u**3*p0[i] + 3*u*u*t*c1[i] + 3*u*t*t*c2[i] + t**3*p3[i] for i in (0, 1))

def points(stroke):
    p, out = stroke[0], []
    for c1, c2, p3 in stroke[1]:
        out += [bez(p, c1, c2, p3, k / 40) for k in range(41)]; p = p3
    return out

def path(stroke, f):
    q = lambda p: ' '.join(f'{v:.2f}'.rstrip('0').rstrip('.') for v in f(p))
    return f'M{q(stroke[0])}' + ''.join(f'C{q(a)} {q(b)} {q(c)}' for a, b, c in stroke[1])

def seg(*pts):  # (start, [(c1,c2,p),...]) from a flat list: start, c1, c2, p, c1, c2, p ...
    return pts[0], [tuple(pts[i:i+3]) for i in range(1, len(pts), 3)]

def join(a, b):  # concatenate two strokes (b starts where a ends)
    return a[0], a[1] + b[1]

MARKS = {
    # One continuous line: rises into a tall teardrop loop, crosses itself, sweeps out into an underline.
    'ribbon': [seg((5, 17.5), (8, 14.5), (14.2, 9.5), (14.2, 5.6), (14.2, 3.6), (12.9, 2.6), (11.6, 2.6),
                   (10.1, 2.6), (9.2, 4), (9.2, 6.2), (9.2, 10.5), (10.2, 16.2), (12.4, 18.8),
                   (14.2, 20.8), (17.2, 20.3), (19.8, 18.2))],
    # One line drawing a speech bubble whose tail crosses back over its start.
    'bubble': [join(join(seg((5, 20.5), (7.5, 19.8), (9.5, 16.2), (12.5, 16.2)), arc(12.5, 10, 7.5, 90, -180, 6.2)),
                    seg((5, 10), (5, 13.2), (6.8, 15.8), (8.6, 17.4), (9.1, 17.85), (9.6, 18.2), (10.1, 18.45)))],
    # Two matching open arcs, turned 180 degrees about the centre, like two voices.
    'twin': [arc(10, 10.5, 5.6, 25, 295), arc(14, 13.5, 5.6, 205, 475)],
}

SW = 1.8       # stroke width in grid units
BOX = 620      # longest side of the mark (incl. stroke) in the 1024 tile

def build(name, strokes):
    pts = [p for s in strokes for p in points(s)]
    x0, x1 = min(p[0] for p in pts) - SW/2, max(p[0] for p in pts) + SW/2
    y0, y1 = min(p[1] for p in pts) - SW/2, max(p[1] for p in pts) + SW/2
    cx, cy, side = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0)
    s = BOX / side
    big = lambda p: (512 + (p[0] - cx) * s, 512 + (p[1] - cy) * s)
    small = lambda p: (12 + p[0] - cx, 12 + p[1] - cy)
    paths = ''.join(f'<path d="{path(st, big)}"/>' for st in strokes)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d28d9"/><stop offset="1" stop-color="#2563eb"/></linearGradient>
    <linearGradient id="ink" x1="0" x2="0" y1="{512 - BOX/2:.0f}" y2="{512 + BOX/2:.0f}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dbe4ff"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="18"/><feOffset dy="14" result="b"/><feFlood flood-color="#1e1b4b" flood-opacity="0.35"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#bg)"/>
  <g fill="none" stroke="url(#ink)" stroke-width="{SW * s:.1f}" stroke-linecap="round" stroke-linejoin="round" filter="url(#shadow)">{paths}</g>
</svg>
'''
    open(f'mark-{name}.svg', 'w').write(svg)
    print(name, 'box24', round(x1 - x0, 2), 'x', round(y1 - y0, 2))
    for st in strokes: print('  ', path(st, small))

for n in (sys.argv[1:] or MARKS): build(n, MARKS[n])
