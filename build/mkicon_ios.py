"""iOS app icon and launch screen from icon.svg.
Writes, under ios/App/App/Assets.xcassets:
  AppIcon.appiconset/AppIcon-512@2x.png   the tile, full-bleed and opaque (iOS rounds the corners itself and rejects transparency)
  Splash.imageset/splash-2732x2732*.png   the rounded icon.png centred on the app's dark background (the launch screen scales it to fill)
Needs Inkscape and Pillow.
Regenerate: python3 build/mkicon_ios.py"""
import os, re, subprocess, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '..', 'ios', 'App', 'App', 'Assets.xcassets')
svg = open(os.path.join(HERE, 'icon.svg')).read()
svg, n = re.subn(r'<rect x="32" y="32" width="960" height="960" rx="224"', '<rect x="0" y="0" width="1024" height="1024"', svg)
assert n == 1, 'icon.svg no longer has the tile this script expects'

with tempfile.TemporaryDirectory() as tmp:
    src, png = os.path.join(tmp, 'icon.svg'), os.path.join(tmp, 'icon.png')
    open(src, 'w').write(svg)
    subprocess.run(['inkscape', src, '-o', png, '-w', '1024'], check=True, capture_output=True)
    icon = Image.open(png).convert('RGB')
    icon.save(os.path.join(ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'))
    splash = Image.new('RGB', (2732, 2732), '#0f1014') # --bg in index.html (dark)
    tile = Image.open(os.path.join(HERE, 'icon.png')).resize((360, 360), Image.LANCZOS) # the rounded tile, as on the desktop
    splash.paste(tile, ((2732 - 360) // 2,) * 2, tile)
    for name in ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']: splash.save(os.path.join(ASSETS, 'Splash.imageset', name))
print('Wrote the iOS icon and launch screen')
