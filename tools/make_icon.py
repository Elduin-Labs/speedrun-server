# Draws server-icon.png: a glowing pixel sword on a green background (64x64).
from PIL import Image, ImageDraw, ImageFilter
import math

S, P = 64, 4  # final size, size of one "pixel"
grid = {}
def put(x, y, c): grid[(x, y)] = c

BLADE_HI, BLADE, BLADE_DK = (240, 255, 255), (150, 235, 255), (70, 170, 220)
GOLD, GOLD_DK = (255, 214, 70), (196, 140, 30)
GRIP, GRIP_DK = (130, 82, 44), (90, 55, 28)

for k in range(8):                       # blade, bottom-left to top-right
    put(6 + k, 9 - k, BLADE_HI)
    put(7 + k, 9 - k, BLADE)
    put(6 + k, 8 - k, BLADE_DK)
put(14, 1, BLADE_HI); put(14, 2, BLADE); put(13, 1, BLADE_DK)
for x, y in [(3, 8), (4, 9), (5, 10), (6, 11)]:   # cross-guard
    put(x, y, GOLD)
put(2, 7, GOLD_DK); put(7, 12, GOLD_DK)
put(4, 11, GRIP); put(3, 12, GRIP_DK); put(5, 12, GRIP_DK); put(4, 12, GRIP)  # grip
put(2, 13, GOLD); put(3, 13, GOLD_DK); put(2, 14, GOLD_DK)                   # pommel

sword = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(sword)
for (x, y), c in grid.items():
    d.rectangle([x * P, y * P, x * P + P - 1, y * P + P - 1], fill=c + (255,))

# green background, lighter in the middle
bg = Image.new("RGBA", (S, S))
for y in range(S):
    for x in range(S):
        t = min(1, math.hypot(x - 32, y - 32) / 40)
        bg.putpixel((x, y), (int(80 - 45 * t), int(200 - 95 * t), int(80 - 45 * t), 255))
# blocky darker border like a Minecraft tile
bd = ImageDraw.Draw(bg)
bd.rectangle([0, 0, S - 1, S - 1], outline=(20, 70, 25, 255), width=P)

# the glow: a blurred bright copy of the sword under it
mask = sword.split()[3]
glow = Image.new("RGBA", (S, S), (200, 255, 255, 0))
glow.putalpha(mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(5)))
out = Image.alpha_composite(bg, glow)
out = Image.alpha_composite(out, glow)
out = Image.alpha_composite(out, sword)
out.convert("RGB").save("server-icon.png")
