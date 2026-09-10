"""Create a Windows icon from a transparent PNG. Requires Pillow."""
import argparse
from pathlib import Path
from PIL import Image
import shutil

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', nargs='?', type=Path, default=root / 'assets' / 'icon.png')
source = parser.parse_args().source.resolve()
assets = root / 'assets'
assets.mkdir(exist_ok=True)
im = Image.open(source)
assert im.mode == 'RGBA' and im.getchannel('A').getextrema() == (0, 255), 'Icon must have actual alpha transparency'
if source != (assets / 'icon.png').resolve():
    shutil.copy2(source, assets / 'icon.png')
im.save(assets / 'icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Saved RGBA PNG and multi-resolution ICO:', assets)
